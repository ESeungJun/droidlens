import { useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './App';
import { useI18n, type Lang } from './i18n';

/**
 * 기기가 없는 사용자를 위한 연결 도우미.
 * 에뮬레이터 설치는 OS·CPU마다 달라서, Claude Code 에이전트에게 맡길 프롬프트를 복사해 주는 것을 기본으로 한다.
 * SDK 는 DroidLens 가 adb 를 자동으로 찾는 기본 위치에 설치하게 한다 (GUI 앱은 셸의 ANDROID_HOME 을 물려받지 못한다).
 */
type Os = 'mac-arm64' | 'mac-x64' | 'win' | 'linux';

const OS_LABEL: Record<Os, string> = {
  'mac-arm64': 'macOS (Apple silicon)',
  'mac-x64': 'macOS (Intel)',
  win: 'Windows',
  linux: 'Linux',
};

interface OsSpec {
  sdk: string;
  image: string;
  jdk: { ko: string; en: string };
  tools: { ko: string; en: string };
  virt: { ko: string; en: string };
  shell: { ko: string; en: string };
}

const API = 35;

function spec(os: Os, winArm: boolean): OsSpec {
  const img = (abi: string) => `system-images;android-${API};google_apis_playstore;${abi}`;
  switch (os) {
    case 'mac-arm64':
    case 'mac-x64':
      return {
        sdk: '~/Library/Android/sdk',
        image: img(os === 'mac-arm64' ? 'arm64-v8a' : 'x86_64'),
        jdk: {
          ko: 'JDK 17 이상: Homebrew 로 `brew install --cask temurin@17` (Homebrew 가 없으면 설치할지 먼저 물어봐)',
          en: 'JDK 17+: `brew install --cask temurin@17` via Homebrew (if Homebrew is missing, ask me before installing it)',
        },
        tools: {
          ko: 'Android 명령줄 도구: `brew install --cask android-commandlinetools`',
          en: 'Android command-line tools: `brew install --cask android-commandlinetools`',
        },
        virt: { ko: 'macOS 는 별도 가상화 설정이 필요 없어.', en: 'macOS needs no extra virtualization setup.' },
        shell: { ko: '터미널(zsh)', en: 'Terminal (zsh)' },
      };
    case 'win':
      return {
        sdk: '%LOCALAPPDATA%\\Android\\Sdk',
        image: img(winArm ? 'arm64-v8a' : 'x86_64'),
        jdk: {
          ko: 'JDK 17 이상: `winget install EclipseAdoptium.Temurin.17.JDK`',
          en: 'JDK 17+: `winget install EclipseAdoptium.Temurin.17.JDK`',
        },
        tools: {
          ko: 'Android 명령줄 도구: developer.android.com/studio 의 "Command line tools only" Windows zip 최신 버전을 받아 SDK 폴더의 `cmdline-tools\\latest` 에 풀어 (`cmdline-tools\\latest\\bin\\sdkmanager.bat` 이 되게)',
          en: 'Android command-line tools: download the latest "Command line tools only" Windows zip from developer.android.com/studio and extract it to `cmdline-tools\\latest` in the SDK folder (so that `cmdline-tools\\latest\\bin\\sdkmanager.bat` exists)',
        },
        virt: {
          ko: '"Windows 하이퍼바이저 플랫폼(Windows Hypervisor Platform)" 이 켜져 있는지 확인하고, 꺼져 있으면 켜는 방법을 알려줘 (관리자 권한·재부팅이 필요할 수 있어).',
          en: 'Check that "Windows Hypervisor Platform" is enabled; if not, tell me how to enable it (may need admin rights and a reboot).',
        },
        shell: { ko: 'PowerShell', en: 'PowerShell' },
      };
    case 'linux':
      return {
        sdk: '~/Android/Sdk',
        image: img('x86_64'),
        jdk: {
          ko: 'JDK 17 이상: 배포판 패키지 매니저로 설치 (예: `sudo apt install openjdk-17-jdk`)',
          en: 'JDK 17+: install with the distro package manager (e.g. `sudo apt install openjdk-17-jdk`)',
        },
        tools: {
          ko: 'Android 명령줄 도구: developer.android.com/studio 의 "Command line tools only" Linux zip 최신 버전을 받아 SDK 폴더의 `cmdline-tools/latest` 에 풀어',
          en: 'Android command-line tools: download the latest "Command line tools only" Linux zip from developer.android.com/studio and extract it to `cmdline-tools/latest` in the SDK folder',
        },
        virt: {
          ko: 'KVM 을 쓸 수 있는지(`/dev/kvm` 권한) 확인하고, 안 되면 kvm 그룹에 추가하는 방법을 알려줘.',
          en: 'Check that KVM is usable (`/dev/kvm` permissions); if not, tell me how to add myself to the kvm group.',
        },
        shell: { ko: '터미널', en: 'terminal' },
      };
  }
}

function buildPrompt(os: Os, winArm: boolean, lang: Lang): string {
  const s = spec(os, winArm);
  const l = (v: { ko: string; en: string }) => v[lang];
  if (lang === 'en')
    return `Install and start an Android emulator on this computer using only the command-line tools. Do not install Android Studio. I'll use it with DroidLens (an Android app analysis tool).

Environment: ${OS_LABEL[os]}${os === 'win' && winArm ? ' on ARM' : ''}, ${l(s.shell)}

Steps
1. First check what's already installed: the adb, emulator and sdkmanager commands, and the SDK folder ${s.sdk}. Reuse whatever exists and install only what's missing.
2. Check free disk space and tell me (about 8 GB is needed). If there isn't enough, stop and ask me.
3. ${l(s.jdk)}
4. ${l(s.tools)}. The SDK location must be ${s.sdk} — DroidLens looks for adb there automatically.
5. With sdkmanager --sdk_root=${s.sdk}, accept the licenses and install: cmdline-tools;latest, platform-tools, emulator, platforms;android-${API}, ${s.image}
6. Using avdmanager from ${s.sdk}/cmdline-tools/latest/bin, create an AVD named "droidlens" (device profile pixel_7). If it already exists, reuse it.
7. ${l(s.virt)}
8. Start the emulator in the background and wait until it shows as "device" in adb devices and \`adb shell getprop sys.boot_completed\` returns 1.
9. When done, give me the one-line command to start the emulator next time. If shell profile changes (PATH etc.) are needed, ask me before changing them.

Tell me before running any step that needs admin rights (sudo or an elevated PowerShell).`;
  return `이 컴퓨터에 Android 에뮬레이터를 명령줄 도구만으로 설치하고 실행해줘. Android Studio 는 설치하지 마. DroidLens(Android 앱 분석 도구)에서 쓸 거야.

환경: ${OS_LABEL[os]}${os === 'win' && winArm ? ' (ARM)' : ''}, ${l(s.shell)}

진행 순서
1. 먼저 이미 설치된 게 있는지 확인해: adb, emulator, sdkmanager 명령과 SDK 폴더 ${s.sdk}. 있는 건 재사용하고 없는 것만 설치해.
2. 디스크 여유 공간을 확인해서 알려줘 (약 8GB 필요). 부족하면 멈추고 물어봐.
3. ${l(s.jdk)}
4. ${l(s.tools)}. SDK 위치는 반드시 ${s.sdk} 로 해 — DroidLens 가 이 위치의 adb 를 자동으로 찾아.
5. sdkmanager --sdk_root=${s.sdk} 로 라이선스에 동의하고 cmdline-tools;latest, platform-tools, emulator, platforms;android-${API}, ${s.image} 를 설치해.
6. ${s.sdk}/cmdline-tools/latest/bin 의 avdmanager 로 "droidlens" 라는 AVD 를 만들어 (기기 프로필 pixel_7, 이미 있으면 그대로 사용).
7. ${l(s.virt)}
8. 에뮬레이터를 백그라운드로 실행하고, adb devices 에 device 로 보이고 \`adb shell getprop sys.boot_completed\` 가 1 이 될 때까지 기다려.
9. 끝나면 다음부터 에뮬레이터를 켜는 명령 한 줄을 알려줘. 셸 설정(PATH 등)을 바꿔야 하면 바꾸기 전에 나에게 물어봐.

관리자 권한(sudo, 관리자 PowerShell)이 필요한 단계는 실행하기 전에 알려줘.`;
}

/** macOS 는 Homebrew 로 명령만 붙여 넣으면 끝까지 갈 수 있다 */
function macCommands(os: Os): string {
  const image = spec(os, false).image;
  return `brew install --cask temurin@17 android-commandlinetools
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "cmdline-tools;latest" "platform-tools" "emulator" "platforms;android-${API}" "${image}"
echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n droidlens -k "${image}" -d pixel_7
"$ANDROID_HOME/emulator/emulator" -avd droidlens &`;
}

function detectOs(p: { platform: string; arch: string }): Os {
  if (p.platform === 'darwin') return p.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p.platform === 'win32') return 'win';
  return 'linux';
}

export function DeviceSetup() {
  const { toast } = useApp();
  const { lang, t } = useI18n();
  const [os, setOs] = useState<Os>('mac-arm64');
  const [winArm, setWinArm] = useState(false);
  const [show, setShow] = useState<'prompt' | 'manual' | null>(null);

  useEffect(() => {
    api
      .platform()
      .then((p) => {
        setOs(detectOs(p));
        setWinArm(p.platform === 'win32' && p.arch === 'arm64');
      })
      .catch(() => undefined);
  }, []);

  const prompt = buildPrompt(os, winArm, lang);
  const copy = (text: string, msg: string) => api.copy(text).then(() => toast(msg));
  const sdk = spec(os, winArm).sdk;

  return (
    <div className="card" style={{ maxWidth: 760, textAlign: 'left' }}>
      <h5>{t('기기 연결 도우미')}</h5>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="muted">{t('운영체제')}</span>
        <select className="input" value={os} onChange={(e) => setOs(e.target.value as Os)}>
          {(Object.keys(OS_LABEL) as Os[]).map((k) => (
            <option key={k} value={k}>{OS_LABEL[k]}</option>
          ))}
        </select>
      </div>

      <div className="setup-step">
        <b>{t('① Claude Code 에게 에뮬레이터 설치 맡기기')} <span className="pill accent">{t('추천')}</span></b>
        <p className="muted">
          {t('아래 프롬프트를 복사해 터미널의 Claude Code 에 붙여 넣으면, 이 컴퓨터에 맞게 명령줄 도구와 에뮬레이터를 설치하고 켜 줍니다. 약 8GB 를 내려받습니다.')}
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn primary" onClick={() => copy(prompt, t('프롬프트를 복사했습니다. Claude Code 에 붙여 넣으세요'))}>{t('프롬프트 복사')}</button>
          <button className="btn" onClick={() => setShow(show === 'prompt' ? null : 'prompt')}>{show === 'prompt' ? t('접기') : t('내용 보기')}</button>
        </div>
        {show === 'prompt' && <pre className="setup-pre">{prompt}</pre>}
      </div>

      <div className="setup-step">
        <b>{t('② 직접 설치')}</b>
        {os.startsWith('mac') ? (
          <>
            <p className="muted">{t('Homebrew 가 있으면 아래 명령을 터미널에 붙여 넣으면 됩니다.')}</p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" onClick={() => copy(macCommands(os), t('명령을 복사했습니다'))}>{t('명령 복사')}</button>
              <button className="btn" onClick={() => setShow(show === 'manual' ? null : 'manual')}>{show === 'manual' ? t('접기') : t('내용 보기')}</button>
            </div>
            {show === 'manual' && <pre className="setup-pre">{macCommands(os)}</pre>}
          </>
        ) : (
          <ol className="muted setup-ol">
            <li>{t('JDK 17 이상을 설치합니다.')}</li>
            <li>
              {t('developer.android.com 에서 "Command line tools only" 를 받아 {sdk} 아래 cmdline-tools/latest 에 풉니다.', { sdk })}{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); api.openExternal('https://developer.android.com/studio#command-tools'); }}>{t('내려받기 페이지')}</a>
            </li>
            <li>{t('sdkmanager 로 platform-tools, emulator, 시스템 이미지를 설치하고 avdmanager 로 가상 기기를 만듭니다.')}</li>
            <li>{os === 'win' ? t('Windows 하이퍼바이저 플랫폼을 켭니다.') : t('KVM 을 쓸 수 있는지 확인합니다.')}</li>
          </ol>
        )}
      </div>

      <div className="setup-step">
        <b>{t('③ 실제 폰 연결')}</b>
        <ol className="muted setup-ol">
          <li>{t('설정 → 휴대전화 정보 → 빌드 번호를 7번 눌러 개발자 옵션을 켭니다.')}</li>
          <li>{t('개발자 옵션에서 USB 디버깅을 켭니다.')}</li>
          <li>{t('USB 로 연결하고 폰에 뜨는 "USB 디버깅 허용" 을 누릅니다.')}</li>
        </ol>
      </div>

      <div className="setup-step">
        <b>{t('④ 무선·원격 기기')}</b>
        <p className="muted">
          {t('Android 11 이상은 개발자 옵션 → 무선 디버깅에서 페어링한 뒤, 클라우드 기기는 제공된 주소로 연결합니다.')}
        </p>
        <pre className="setup-pre">{'adb pair <ip>:<pair-port>\nadb connect <ip>:<port>'}</pre>
      </div>
    </div>
  );
}
