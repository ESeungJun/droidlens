import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

/**
 * APK 정적 분석: classes*.dex의 type_ids에서 클래스 이름을 뽑아 알려진 라이브러리 시그니처와 매칭하고,
 * lib/ 아래 네이티브 .so, assets의 프레임워크 흔적도 함께 본다.
 */

export interface LibrarySignature {
  name: string;
  category: LibraryCategory;
  /** 'Lcom/squareup/okhttp3/' 형식 대신 점 표기 패키지 접두사 */
  packages?: string[];
  /** lib/<abi>/ 아래 .so 파일 이름 정규식 */
  natives?: RegExp[];
  /** zip 엔트리 경로 정규식 */
  files?: RegExp[];
  /** packages 매칭에서 제외할 하위 패키지 */
  excludePackages?: string[];
  /** 클래스만으로 판정할 때 필요한 최소 클래스 수 (네이티브/파일 근거가 있으면 무시) */
  minClasses?: number;
  note?: string;
}

export type LibraryCategory =
  | 'framework'
  | 'ui'
  | 'network'
  | 'di'
  | 'async'
  | 'image'
  | 'storage'
  | 'serialization'
  | 'analytics'
  | 'crash'
  | 'ads'
  | 'payment'
  | 'auth'
  | 'media'
  | 'debug'
  | 'security'
  | 'map'
  | 'push'
  | 'other';

export const SIGNATURES: LibrarySignature[] = [
  // 크로스플랫폼 프레임워크
  { name: 'Flutter', category: 'framework', packages: ['io.flutter'], natives: [/libflutter\.so$/], files: [/flutter_assets\//] },
  { name: 'React Native', category: 'framework', packages: ['com.facebook.react'], natives: [/libreactnativejni\.so$/, /libhermes\.so$/] },
  { name: 'Hermes (JS 엔진)', category: 'framework', natives: [/libhermes\.so$/] },
  { name: 'Unity', category: 'framework', packages: ['com.unity3d.player'], natives: [/libunity\.so$/, /libil2cpp\.so$/], minClasses: 30 },
  { name: 'Unreal Engine', category: 'framework', natives: [/libUE4\.so$/, /libUnreal\.so$/] },
  { name: 'Xamarin / .NET MAUI', category: 'framework', packages: ['mono.android', 'crc64'], natives: [/libmonodroid\.so$/] },
  { name: 'Cordova / Capacitor', category: 'framework', packages: ['org.apache.cordova', 'com.getcapacitor'] },
  { name: 'Kotlin Multiplatform (Compose MP)', category: 'framework', packages: ['org.jetbrains.compose'] },
  // UI
  { name: 'Jetpack Compose', category: 'ui', packages: ['androidx.compose.ui', 'androidx.compose.runtime'] },
  { name: 'Compose Material3', category: 'ui', packages: ['androidx.compose.material3'] },
  { name: 'Material Components', category: 'ui', packages: ['com.google.android.material'] },
  { name: 'ConstraintLayout', category: 'ui', packages: ['androidx.constraintlayout'] },
  { name: 'Jetpack Navigation', category: 'ui', packages: ['androidx.navigation'] },
  { name: 'Lottie', category: 'ui', packages: ['com.airbnb.lottie'] },
  { name: 'Epoxy', category: 'ui', packages: ['com.airbnb.epoxy'] },
  { name: 'Paging', category: 'ui', packages: ['androidx.paging'] },
  { name: 'Shimmer', category: 'ui', packages: ['com.facebook.shimmer'] },
  { name: 'Accompanist', category: 'ui', packages: ['com.google.accompanist'] },
  // 네트워크
  { name: 'OkHttp', category: 'network', packages: ['okhttp3'] },
  { name: 'Retrofit', category: 'network', packages: ['retrofit2'] },
  { name: 'Ktor Client', category: 'network', packages: ['io.ktor.client'] },
  { name: 'Volley', category: 'network', packages: ['com.android.volley'] },
  { name: 'Apollo GraphQL', category: 'network', packages: ['com.apollographql'] },
  { name: 'gRPC', category: 'network', packages: ['io.grpc'] },
  { name: 'Cronet', category: 'network', packages: ['org.chromium.net'], natives: [/libcronet.*\.so$/] },
  { name: 'Socket.IO', category: 'network', packages: ['io.socket'] },
  // DI
  { name: 'Dagger', category: 'di', packages: ['dagger'] },
  { name: 'Hilt', category: 'di', packages: ['dagger.hilt'] },
  { name: 'Koin', category: 'di', packages: ['org.koin'] },
  { name: 'Toothpick', category: 'di', packages: ['toothpick'] },
  // 비동기
  { name: 'Kotlin Coroutines', category: 'async', packages: ['kotlinx.coroutines'] },
  { name: 'RxJava 2', category: 'async', packages: ['io.reactivex'], excludePackages: ['io.reactivex.rxjava3'] },
  { name: 'RxJava 3', category: 'async', packages: ['io.reactivex.rxjava3'] },
  { name: 'WorkManager', category: 'async', packages: ['androidx.work'] },
  // 이미지
  { name: 'Glide', category: 'image', packages: ['com.bumptech.glide'] },
  { name: 'Coil', category: 'image', packages: ['coil', 'coil3'] },
  { name: 'Picasso', category: 'image', packages: ['com.squareup.picasso'] },
  { name: 'Fresco', category: 'image', packages: ['com.facebook.fresco', 'com.facebook.imagepipeline'] },
  // 저장소
  { name: 'Room', category: 'storage', packages: ['androidx.room'] },
  { name: 'DataStore', category: 'storage', packages: ['androidx.datastore'] },
  { name: 'Realm', category: 'storage', packages: ['io.realm'], natives: [/librealm.*\.so$/] },
  { name: 'SQLDelight', category: 'storage', packages: ['app.cash.sqldelight', 'com.squareup.sqldelight'] },
  { name: 'MMKV', category: 'storage', packages: ['com.tencent.mmkv'], natives: [/libmmkv\.so$/] },
  { name: 'SQLCipher', category: 'security', packages: ['net.sqlcipher', 'net.zetetic'], natives: [/libsqlcipher\.so$/] },
  { name: 'ObjectBox', category: 'storage', packages: ['io.objectbox'] },
  // 직렬화
  { name: 'Gson', category: 'serialization', packages: ['com.google.gson'] },
  { name: 'Moshi', category: 'serialization', packages: ['com.squareup.moshi'] },
  { name: 'kotlinx.serialization', category: 'serialization', packages: ['kotlinx.serialization'] },
  { name: 'Jackson', category: 'serialization', packages: ['com.fasterxml.jackson'] },
  { name: 'Protobuf', category: 'serialization', packages: ['com.google.protobuf'] },
  // 분석 / 마케팅
  { name: 'Firebase Analytics', category: 'analytics', packages: ['com.google.firebase.analytics'] },
  { name: 'Google Analytics (GMS measurement)', category: 'analytics', packages: ['com.google.android.gms.measurement'] },
  { name: 'Amplitude', category: 'analytics', packages: ['com.amplitude'] },
  { name: 'Mixpanel', category: 'analytics', packages: ['com.mixpanel'] },
  { name: 'AppsFlyer', category: 'analytics', packages: ['com.appsflyer'] },
  { name: 'Adjust', category: 'analytics', packages: ['com.adjust.sdk'] },
  { name: 'Branch', category: 'analytics', packages: ['io.branch'] },
  { name: 'Braze', category: 'analytics', packages: ['com.braze', 'com.appboy'] },
  { name: 'Airbridge', category: 'analytics', packages: ['co.ab180.airbridge'] },
  { name: 'Segment', category: 'analytics', packages: ['com.segment.analytics'] },
  { name: 'Facebook SDK', category: 'analytics', packages: ['com.facebook.appevents', 'com.facebook.FacebookSdk'] },
  { name: 'Hackle', category: 'analytics', packages: ['io.hackle'] },
  // 크래시 / 모니터링
  { name: 'Firebase Crashlytics', category: 'crash', packages: ['com.google.firebase.crashlytics'] },
  { name: 'Sentry', category: 'crash', packages: ['io.sentry'] },
  { name: 'Bugsnag', category: 'crash', packages: ['com.bugsnag'] },
  { name: 'Datadog', category: 'crash', packages: ['com.datadog'] },
  { name: 'New Relic', category: 'crash', packages: ['com.newrelic'] },
  // 광고
  { name: 'Google Mobile Ads (AdMob)', category: 'ads', packages: ['com.google.android.gms.ads'] },
  { name: 'AppLovin', category: 'ads', packages: ['com.applovin'] },
  { name: 'Unity Ads', category: 'ads', packages: ['com.unity3d.ads', 'com.unity3d.services'] },
  { name: 'IronSource', category: 'ads', packages: ['com.ironsource'] },
  { name: 'Meta Audience Network', category: 'ads', packages: ['com.facebook.ads'] },
  { name: 'Kakao AdFit', category: 'ads', packages: ['com.kakao.adfit'] },
  // 결제 / 인증
  { name: 'Google Play Billing', category: 'payment', packages: ['com.android.billingclient'] },
  { name: 'RevenueCat', category: 'payment', packages: ['com.revenuecat'] },
  { name: 'Toss Payments', category: 'payment', packages: ['com.tosspayments'] },
  { name: 'Iamport / PortOne', category: 'payment', packages: ['com.iamport'] },
  { name: 'Kakao SDK', category: 'auth', packages: ['com.kakao.sdk'] },
  { name: 'Naver Login', category: 'auth', packages: ['com.navercorp.nid', 'com.nhn.android.naverlogin'] },
  { name: 'Google Sign-In / Credential Manager', category: 'auth', packages: ['com.google.android.gms.auth', 'androidx.credentials'] },
  { name: 'Firebase Auth', category: 'auth', packages: ['com.google.firebase.auth'] },
  // 푸시 / 맵 / 미디어
  { name: 'Firebase Cloud Messaging', category: 'push', packages: ['com.google.firebase.messaging'] },
  { name: 'OneSignal', category: 'push', packages: ['com.onesignal'] },
  { name: 'Google Maps', category: 'map', packages: ['com.google.android.gms.maps'] },
  { name: 'Naver Map', category: 'map', packages: ['com.naver.maps'] },
  { name: 'Kakao Map', category: 'map', packages: ['com.kakao.vectormap', 'net.daum.mf.map'] },
  { name: 'ExoPlayer', category: 'media', packages: ['com.google.android.exoplayer2'] },
  { name: 'Media3', category: 'media', packages: ['androidx.media3'] },
  { name: 'CameraX', category: 'media', packages: ['androidx.camera'] },
  { name: 'ML Kit', category: 'media', packages: ['com.google.mlkit'] },
  { name: 'ZXing', category: 'media', packages: ['com.google.zxing'] },
  // 디버그 / 보안
  { name: 'Timber', category: 'debug', packages: ['timber.log'] },
  { name: 'LeakCanary', category: 'debug', packages: ['leakcanary'], note: '릴리스 빌드에 포함되어 있다면 설정 실수' },
  { name: 'Chucker', category: 'debug', packages: ['com.chuckerteam'] },
  { name: 'Flipper', category: 'debug', packages: ['com.facebook.flipper'] },
  { name: 'Stetho', category: 'debug', packages: ['com.facebook.stetho'] },
  { name: 'Play Integrity', category: 'security', packages: ['com.google.android.play.core.integrity'] },
  { name: 'SafetyNet', category: 'security', packages: ['com.google.android.gms.safetynet'] },
  { name: 'Tink', category: 'security', packages: ['com.google.crypto.tink'] },
  { name: 'Root/탐지 (RootBeer)', category: 'security', packages: ['com.scottyab.rootbeer'] },
  { name: 'DexGuard / 상용 난독화 흔적', category: 'security', natives: [/libdexguard.*\.so$/, /libshield\.so$/, /libjiagu.*\.so$/, /libsecexe\.so$/] },
  // 기타 Jetpack
  { name: 'Lifecycle / ViewModel', category: 'other', packages: ['androidx.lifecycle'] },
  { name: 'Kotlin stdlib', category: 'other', packages: ['kotlin'] },
];

// ---------- DEX 파서 (type_ids → 클래스 디스크립터) ----------

function readUleb128(buf: Uint8Array, off: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[off++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80 && shift < 35);
  return [result >>> 0, off];
}

/** MUTF-8 디코딩 (클래스 이름은 사실상 ASCII라 단순 처리) */
function readMutf8(buf: Uint8Array, off: number): string {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return Buffer.from(buf.subarray(off, end)).toString('utf8');
}

export function dexClassNames(dex: Uint8Array): string[] {
  const dv = new DataView(dex.buffer, dex.byteOffset, dex.byteLength);
  const magic = Buffer.from(dex.subarray(0, 4)).toString('latin1');
  if (magic !== 'dex\n') return [];
  const stringIdsSize = dv.getUint32(0x38, true);
  const stringIdsOff = dv.getUint32(0x3c, true);
  const typeIdsSize = dv.getUint32(0x40, true);
  const typeIdsOff = dv.getUint32(0x44, true);
  const out: string[] = [];
  for (let i = 0; i < typeIdsSize; i++) {
    const strIdx = dv.getUint32(typeIdsOff + i * 4, true);
    if (strIdx >= stringIdsSize) continue;
    const dataOff = dv.getUint32(stringIdsOff + strIdx * 4, true);
    const [, strStart] = readUleb128(dex, dataOff);
    const desc = readMutf8(dex, strStart);
    // 'Lcom/foo/Bar;' 형태의 참조 타입만
    if (desc.startsWith('L') && desc.endsWith(';')) out.push(desc.slice(1, -1).replace(/\//g, '.'));
  }
  return out;
}

// ---------- 분석 ----------

export interface DetectedLibrary {
  name: string;
  category: LibraryCategory;
  evidence: string[];
  classCount: number;
  note?: string;
}

export interface ApkAnalysis {
  apkFiles: string[];
  dexCount: number;
  classCount: number;
  /** 앱 자체 코드로 추정되는 클래스 수 (패키지 이름 접두사 기준) */
  appClassCount: number;
  nativeLibs: { abi: string; name: string; size: number }[];
  abis: string[];
  libraries: DetectedLibrary[];
  /** 시그니처에 없는 상위 패키지 (클래스 수 많은 순) */
  unknownPackages: { pkg: string; classes: number }[];
  obfuscation: { shortNameRatio: number; likelyObfuscated: boolean };
  minified: boolean;
  kotlin: boolean;
}

function packagePrefix(cls: string, depth: number): string {
  const parts = cls.split('.');
  parts.pop();
  return parts.slice(0, depth).join('.');
}

export async function analyzeApk(apkPaths: string[], appPackage?: string): Promise<ApkAnalysis> {
  const classes: string[] = [];
  const nativeLibs: ApkAnalysis['nativeLibs'] = [];
  const fileNames: string[] = [];
  let dexCount = 0;

  for (const apk of apkPaths) {
    const data = new Uint8Array(await readFile(apk));
    const entries = unzipSync(data, {
      filter: (f) => {
        fileNames.push(f.name);
        if (f.name.startsWith('lib/') && f.name.endsWith('.so')) {
          const [, abi, name] = f.name.split('/');
          nativeLibs.push({ abi, name, size: f.originalSize });
          return false;
        }
        return /^classes\d*\.dex$/.test(f.name);
      },
    });
    for (const [name, buf] of Object.entries(entries)) {
      if (name.endsWith('.dex')) {
        dexCount++;
        classes.push(...dexClassNames(buf));
      }
    }
  }

  const uniqueClasses = [...new Set(classes)];
  const libraries: DetectedLibrary[] = [];
  const claimed = new Set<string>();

  for (const sig of SIGNATURES) {
    const evidence: string[] = [];
    let classCount = 0;
    if (sig.packages) {
      for (const p of sig.packages) {
        const hits = uniqueClasses.filter(
          (c) => (c === p || c.startsWith(p + '.')) && !sig.excludePackages?.some((x) => c.startsWith(x + '.')),
        );
        if (hits.length) {
          classCount += hits.length;
          evidence.push(`${p}.* (${hits.length} classes)`);
          // 상위 2단계 접두사를 '알려진 것'으로 표시
          for (const h of hits) claimed.add(packagePrefix(h, 2));
        }
      }
    }
    for (const re of sig.natives ?? []) {
      const n = nativeLibs.find((l) => re.test(l.name));
      if (n) evidence.push(`lib/${n.abi}/${n.name}`);
    }
    for (const re of sig.files ?? []) {
      const f = fileNames.find((n) => re.test(n));
      if (f) evidence.push(f);
    }
    const strongEvidence = evidence.some((e) => !e.includes(' classes)'));
    if (sig.minClasses && classCount < sig.minClasses && !strongEvidence) continue;
    if (evidence.length) libraries.push({ name: sig.name, category: sig.category, evidence, classCount, note: sig.note });
  }

  const filtered = libraries;

  const appPrefix = appPackage ? appPackage.split('.').slice(0, 2).join('.') : undefined;
  const appClassCount = appPrefix ? uniqueClasses.filter((c) => c.startsWith(appPrefix + '.')).length : 0;

  const unknown = new Map<string, number>();
  for (const c of uniqueClasses) {
    const p2 = packagePrefix(c, 2);
    if (!p2 || claimed.has(p2) || p2.startsWith('android') || p2.startsWith('java') || (appPrefix && p2 === appPrefix)) continue;
    const p3 = packagePrefix(c, 3) || p2;
    unknown.set(p3, (unknown.get(p3) ?? 0) + 1);
  }

  // 난독화 추정: 단순 이름(1~2글자) 클래스 비율
  const simpleNames = uniqueClasses.map((c) => c.split('.').pop() ?? '');
  const short = simpleNames.filter((n) => /^[a-zA-Z]{1,2}(\$\w+)?$/.test(n)).length;
  const shortNameRatio = uniqueClasses.length ? short / uniqueClasses.length : 0;

  return {
    apkFiles: apkPaths,
    dexCount,
    classCount: uniqueClasses.length,
    appClassCount,
    nativeLibs,
    abis: [...new Set(nativeLibs.map((l) => l.abi))],
    libraries: filtered.sort((a, b) => a.category.localeCompare(b.category) || b.classCount - a.classCount),
    unknownPackages: [...unknown.entries()]
      .filter(([, n]) => n >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([pkg, classes]) => ({ pkg, classes })),
    obfuscation: { shortNameRatio: Math.round(shortNameRatio * 1000) / 1000, likelyObfuscated: shortNameRatio > 0.25 },
    minified: shortNameRatio > 0.1,
    kotlin: uniqueClasses.some((c) => c.startsWith('kotlin.')),
  };
}
