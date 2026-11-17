/**
 * 화면 한 장 읽기: 지금 화면의 스냅샷(Activity·뷰 계층·시그니처·스크린샷), 화면이 멈출 때까지 기다리기,
 * 앱 실행 뒤 첫 화면 기다리기, 시스템 ANR·크래시 대화상자 닫기, 그 화면에서 누를 수 있는 요소 고르기.
 * 화면 지도(store)·경로 이동(navigate)·자동 탐색(explore)·흐름 수집(flow)이 모두 이 파일로 화면을 읽는다.
 * 공개 API 는 ../graph.ts 가 다시 내보낸다.
 */
import { createHash } from 'node:crypto';
import { DeviceAdb, sleep } from '../adb.js';
import { ensureAgent } from '../agent.js';
import { assertPackage, currentScreen, launchApp, type CurrentScreen } from '../app.js';
import { screenshot, tap } from '../device.js';
import {
  center,
  dumpHierarchy,
  flatten,
  labelOf,
  pageWebViews,
  screenSignature,
  structureSignature,
  type Hierarchy,
  type ViewNode,
} from '../hierarchy.js';

// ---------- 스냅샷 ----------

export interface Snapshot {
  screen: CurrentScreen;
  hierarchy: Hierarchy;
  signature: string;
  png?: Buffer;
}

export async function captureSnapshot(dev: DeviceAdb, opts: { screenshot?: boolean } = {}): Promise<Snapshot> {
  const [screen, hierarchy, png] = await Promise.all([
    currentScreen(dev),
    dumpHierarchy(dev),
    opts.screenshot === false ? Promise.resolve(undefined) : screenshot(dev),
  ]);
  return { screen, hierarchy, signature: structureSignature(hierarchy.root), png };
}

/** 취소되면 p 를 기다리지 않고 바로 던진다 (p 자체는 끝까지 돈다) */
function orAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}

/**
 * 화면이 안정될 때까지 대기. uiautomator dump(1.5~2.5초)보다 훨씬 빠른 screencap 해시를 연속 비교하고,
 * 안정되면 뷰 계층·Activity를 한 번만 가져온다. 커서 깜빡임 등으로 계속 변하면 timeout에서 멈춘다.
 * 에이전트가 있으면 덤프로 안정을 확인하고 스크린샷은 담지 않는다 (필요하면 addSnapshot 에 dev 를 주면 새 화면일 때만 찍는다).
 * signal 이 취소되면 기다리기를 그만두고 던진다 (더 이상 기기에 덤프·스크린샷을 요청하지 않게).
 */
export async function waitForSettle(
  dev: DeviceAdb,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Snapshot> {
  const { signal } = opts;
  // 에이전트가 있으면 접근성 이벤트가 잠잠해질 때까지 기다리는 쪽이 훨씬 빠르고 정확하다
  const agent = await ensureAgent(dev);
  if (agent) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    await orAbort(sleep(150), signal);
    await orAbort(agent.waitIdle(300, opts.timeoutMs ?? 4000).catch(() => undefined), signal);
    // 프래그먼트 전환 애니메이션은 접근성 이벤트를 거의 내지 않아 idle이 일찍 끝날 수 있다:
    // 덤프(~50ms)를 반복해 구조 시그니처가 연속 두 번 같을 때까지 확인한다.
    // 단 웹 페이지 화면은 틀이 먼저 그려지고 데이터가 0.5~1초 뒤에 채워져서, 같은 구조가 1초 유지돼야 안정으로 본다
    let hierarchy = await dumpHierarchy(dev);
    let sig = structureSignature(hierarchy.root);
    let since = Date.now();
    while (Date.now() < deadline) {
      await orAbort(sleep(250), signal);
      const next = await dumpHierarchy(dev);
      const nextSig = structureSignature(next.root);
      hierarchy = next;
      if (nextSig !== sig) {
        sig = nextSig;
        since = Date.now();
      } else if (Date.now() - since >= (pageWebViews(next.root).length ? 1000 : 0)) break;
    }
    // 스크린샷은 찍지 않는다: 새 화면을 지도에 올릴 때만 addSnapshot 이 찍는다 (재방문·앱 밖 화면마다 PNG 를 받지 않게)
    return fixPackage({ screen: await currentScreen(dev), hierarchy, signature: sig });
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  await orAbort(sleep(opts.intervalMs ?? 250), signal);
  let png = await screenshot(dev);
  let hash = createHash('sha1').update(png).digest('hex');
  while (Date.now() < deadline) {
    await orAbort(sleep(opts.intervalMs ?? 250), signal);
    const next = await screenshot(dev);
    const h = createHash('sha1').update(next).digest('hex');
    png = next;
    if (h === hash) break;
    hash = h;
  }
  const [screen, hierarchy] = await Promise.all([currentScreen(dev), dumpHierarchy(dev)]);
  return fixPackage({ screen, hierarchy, signature: structureSignature(hierarchy.root), png });
}

/** 앱 전환 직후 dumpsys의 포커스 정보가 이전 앱을 가리킬 수 있어, 실제 그려진 뷰의 패키지를 우선한다 */
function fixPackage(s: Snapshot): Snapshot {
  const drawnPkg = s.hierarchy.root.children.at(-1)?.packageName;
  if (drawnPkg && drawnPkg !== s.screen.packageName && drawnPkg !== 'com.android.systemui') {
    s.screen.packageName = drawnPkg;
    s.screen.activity = '';
    s.screen.fragments = [];
  }
  return s;
}

/** 앱 실행 후 해당 패키지가 포그라운드에 그려지고, 스플래시가 지나 화면이 안정될 때까지 대기 */
export async function launchAndSettle(dev: DeviceAdb, pkg: string, opts: { restart?: boolean; timeoutMs?: number } = {}): Promise<Snapshot> {
  assertPackage(pkg);
  if (opts.restart) await dev.shell(`am force-stop ${pkg}`);
  await launchApp(dev, pkg);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const agent = await ensureAgent(dev);
  // 준비 판정은 스크린샷 없이 (뷰 계층 + 현재 Activity만) 빠르게 반복하고, 끝나면 한 번만 전체 스냅샷
  while (Date.now() < deadline) {
    if (agent) await agent.waitIdle(300, 2000).catch(() => undefined);
    else await sleep(700);
    const [screen, hierarchy] = await Promise.all([currentScreen(dev), dumpHierarchy(dev)]);
    const s = fixPackage({ screen, hierarchy, signature: structureSignature(hierarchy.root) });
    if (await dismissSystemDialog(dev, s)) continue;
    const drawn = hierarchy.root.children.some((c) => c.packageName === pkg);
    // 스플래시는 클릭 가능한 요소가 거의 없다: 인앱 + Activity 확인 + 클릭 요소 1개 이상이면 준비 완료
    if (drawn && s.screen.packageName === pkg && s.screen.activity !== '' && candidateActions(s, pkg).length > 0) break;
  }
  return waitForSettle(dev);
}

/**
 * 시스템 ANR/크래시 대화상자 처리. ANR("응답하지 않음")은 '대기', 크래시("중지됨")는 '닫기'를 누른다.
 * 처리했으면 무엇이었는지 반환 (탐색·시나리오에서 오류로 기록).
 */
export async function dismissSystemDialog(dev: DeviceAdb, s: Snapshot): Promise<'anr' | 'crash' | undefined> {
  const nodes = flatten(s.hierarchy.root);
  const wait = nodes.find((n) => n.resourceId === 'android:id/aerr_wait');
  const close = nodes.find((n) => n.resourceId === 'android:id/aerr_close');
  if (!wait && !close) return undefined;
  const target = wait ?? close!;
  const { x, y } = center(target);
  await tap(dev, x, y);
  await sleep(500);
  return wait ? 'anr' : 'crash';
}

// ---------- 화면 id ----------

export function shortName(cls: string): string {
  return cls.split('.').pop() ?? cls;
}

export function screenId(s: Snapshot): string {
  return `${shortName(s.screen.activity) || 'unknown'}@${screenSignature(s.hierarchy.root)}`;
}

// ---------- 누를 수 있는 요소 ----------

export interface Candidate {
  node: ViewNode;
  label: string;
  key: string;
}

/** 요소 라벨. 컨테이너(…Layout 등)는 자식 텍스트로 만든다. 요소 key 는 `리소스 id|라벨` */
export function elementLabel(n: ViewNode): string {
  const own = labelOf(n);
  return own && !/Layout$|View$|Group$/.test(own) ? own : flatten(n).map((c) => c.text || c.contentDesc).find(Boolean) ?? own;
}

export function candidateActions(s: Snapshot, pkg?: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const n of flatten(s.hierarchy.root)) {
    if (!n.clickable || !n.enabled || n.depth === 0) continue;
    if (pkg && n.packageName && n.packageName !== pkg) continue;
    const [l, t, r, b] = n.bounds;
    if (r - l < 8 || b - t < 8) continue;
    if (n.className.endsWith('EditText')) continue;
    const label = elementLabel(n);
    const key = `${n.resourceId}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ node: n, label, key });
  }
  return out;
}

/** 화면의 한 점을 누르면 어떤 요소가 눌리는지 (겹치면 가장 작은 요소) */
export function targetAt(s: Snapshot, pkg: string, x: number, y: number): Candidate | undefined {
  return candidateActions(s, pkg)
    .filter(({ node: { bounds: [l, t, r, b] } }) => x >= l && x <= r && y >= t && y <= b)
    .sort((a, b) => area(a.node) - area(b.node))[0];
}

const area = (n: ViewNode) => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
