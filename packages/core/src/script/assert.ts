import { DeviceAdb, sleep } from '../adb.js';
import { currentScreen, recentCrashes } from '../app.js';
import { dumpHierarchy, findNodes } from '../hierarchy.js';
import { kbToMb, perfSample } from '../perf.js';
import { redactValue } from '../redact.js';
import { sdkFor } from '../sdk.js';
import { StepFailure } from './common.js';
import { selText } from './describe.js';
import type { Assertion } from './schema.js';

/**
 * assert 단계의 검사기. 검사 종류(visible·network·perf 등)마다 검사기 하나를 두고, evaluateAssertion 은 표의 순서대로 해당하는 것만 돌린다.
 * 새 검사를 더하려면 schema.ts 의 assertion 에 칸을, describe.ts 의 describeAssertion 에 문장을, 여기 CHECKS 에 검사기를 더한다.
 */

interface CheckEnv {
  dev: DeviceAdb;
  app: string;
  a: Assertion;
  /** 실행 시작 시각 (기기 시계). 네트워크·이벤트·크래시는 이 뒤의 것만 본다 */
  since: number;
  /** check 가 근거를 돌려줄 때까지 시간 한도 동안 0.4초마다 되풀이한다. 넘으면 failMsg 로 StepFailure */
  retry(check: () => Promise<string | undefined>, failMsg: () => Promise<string> | string): Promise<string>;
}

interface Check {
  applies(a: Assertion): boolean;
  /** 통과 근거 (여러 개면 배열). 실패하면 StepFailure */
  run(e: CheckEnv): Promise<string | string[]>;
}

const visible: Check = {
  applies: (a) => !!a.visible,
  run: ({ dev, a, retry }) =>
    retry(
      async () => {
        const [n] = findNodes((await dumpHierarchy(dev)).root, a.visible!);
        return n ? `보임: ${n.text || n.contentDesc || n.resourceId}` : undefined;
      },
      () => `기대: ${selText(a.visible!)} 보임 / 실제: 없음`,
    ),
};

const notVisible: Check = {
  applies: (a) => !!a.notVisible,
  run: ({ dev, a, retry }) =>
    retry(
      async () => (findNodes((await dumpHierarchy(dev)).root, a.notVisible!).length === 0 ? `안 보임: ${selText(a.notVisible!)}` : undefined),
      () => `기대: ${selText(a.notVisible!)} 안 보임 / 실제: 보임`,
    ),
};

const text: Check = {
  applies: (a) => !!a.text,
  run: ({ dev, a, retry }) => {
    const want = a.text!;
    let actual = '(요소 없음)';
    return retry(
      async () => {
        const [n] = findNodes((await dumpHierarchy(dev)).root, want.of);
        if (!n) return undefined;
        actual = n.text;
        if (want.equals !== undefined && n.text !== want.equals) return undefined;
        if (want.contains !== undefined && !n.text.includes(want.contains)) return undefined;
        return `텍스트 "${n.text}"`;
      },
      () => `기대: ${want.equals !== undefined ? `"${want.equals}"` : `"${want.contains}" 포함`} / 실제: "${actual}"`,
    );
  },
};

/** activity·package 는 한 번 조회로 함께 본다 */
const screen: Check = {
  applies: (a) => !!(a.activity || a.package),
  run: ({ dev, a, retry }) => {
    let actual = '';
    return retry(
      async () => {
        const s = await currentScreen(dev);
        actual = `${s.packageName} ${s.activity}`;
        if (a.package && s.packageName !== a.package) return undefined;
        if (a.activity && !s.activity.endsWith(a.activity)) return undefined;
        return `화면 ${s.activity}`;
      },
      () => `기대: ${a.package ?? ''} ${a.activity ?? ''} / 실제: ${actual}`,
    );
  },
};

const network: Check = {
  applies: (a) => !!a.network,
  run: ({ dev, app, a, since, retry }) => {
    const want = a.network!;
    let seen = '';
    return retry(
      async () => {
        const c = await sdkFor(dev, app);
        const list = (await c.network({ filter: want.url })).filter((e) => e.startedAt >= since && e.state !== 'pending');
        seen = list.map((e) => `${e.method} ${e.status || e.state} ${e.url}`).slice(-3).join('; ') || '해당 URL 요청 없음';
        for (const e of list.reverse()) {
          if (want.method && e.method.toUpperCase() !== want.method.toUpperCase()) continue;
          if (want.status !== undefined && e.status !== want.status) continue;
          if (want.bodyContains) {
            const d = await c.networkDetail(e.id);
            if (!d.responseBody?.includes(want.bodyContains)) continue;
          }
          return `요청 #${e.id} ${e.method} ${e.status} ${e.url}`;
        }
        return undefined;
      },
      () => `기대: ${want.method ?? ''} ${want.url} ${want.status ?? ''} / 실제: ${seen}`,
    );
  },
};

const pref: Check = {
  applies: (a) => !!a.pref,
  run: ({ dev, app, a, retry }) => {
    const want = a.pref!;
    let actual: unknown = '(없음)';
    return retry(
      async () => {
        const files = await (await sdkFor(dev, app)).prefs();
        const v = files.find((f) => f.name === want.file)?.entries[want.key];
        actual = v?.value;
        return v && String(v.value) === String(want.equals) ? `${want.file}.${want.key} = ${redactValue(want.key, String(v.value))}` : undefined;
      },
      // 근거·실패 문구는 리포트에 남으므로 값은 키 이름·모양에 따라 가린다
      () => `기대: ${want.file}.${want.key} = ${redactValue(want.key, String(want.equals))} / 실제: ${redactValue(want.key, String(actual))}`,
    );
  },
};

const db: Check = {
  applies: (a) => !!a.db,
  run: ({ dev, app, a, retry }) => {
    const want = a.db!;
    let actual: unknown = '(없음)';
    return retry(
      async () => {
        const r = await (await sdkFor(dev, app)).query(want.db, want.sql);
        actual = r.rows?.[0]?.[0];
        return String(actual) === String(want.equals) ? `${want.sql} → ${actual}` : undefined;
      },
      () => `기대: ${want.sql} → ${want.equals} / 실제: ${actual}`,
    );
  },
};

const event: Check = {
  applies: (a) => !!a.event,
  run: ({ dev, app, a, since, retry }) =>
    retry(
      async () => {
        const ev = (await (await sdkFor(dev, app)).events()).filter((e) => e.at >= since && e.name === a.event);
        return ev.length ? `이벤트 ${a.event} ${ev.length}회` : undefined;
      },
      () => `기대: 이벤트 ${a.event} / 실제: 기록 없음`,
    ),
};

/** 메모리·버벅임은 되풀이하지 않고 지금 한 번 잰다 */
const perf: Check = {
  applies: (a) => !!a.perf,
  run: async ({ dev, app, a }) => {
    const p = a.perf!;
    const evidence: string[] = [];
    const s = await perfSample(dev, app, { memory: p.maxMemoryMb !== undefined, frames: p.maxJankPercent !== undefined });
    if (!s) throw new StepFailure(`${app} 이(가) 실행 중이 아니라 성능을 잴 수 없습니다`);
    if (p.maxMemoryMb !== undefined) {
      const used = kbToMb(s.memory?.totalPssKb);
      if (used === undefined) throw new StepFailure('메모리를 읽지 못했습니다');
      if (used > p.maxMemoryMb) throw new StepFailure(`기대: 메모리 ${p.maxMemoryMb}MB 이하 / 실제: ${used}MB`);
      evidence.push(`메모리 ${used}MB`);
    }
    if (p.maxJankPercent !== undefined) {
      const f = s.frames;
      if (!f) throw new StepFailure('프레임 통계를 읽지 못했습니다');
      if (f.jankPercent > p.maxJankPercent) throw new StepFailure(`기대: 버벅인 프레임 ${p.maxJankPercent}% 이하 / 실제: ${f.jankPercent}% (${f.jankyFrames}/${f.totalFrames})`);
      evidence.push(`버벅인 프레임 ${f.jankPercent}% (${f.jankyFrames}/${f.totalFrames})`);
    }
    return evidence;
  },
};

const noCrash: Check = {
  applies: (a) => !!a.noCrash,
  run: async ({ dev, app, since }) => {
    const crashes = await recentCrashes(dev, app, { since: since - 1000 });
    if (crashes.length) throw new StepFailure(`크래시 발생:\n${crashes[crashes.length - 1].split('\n').slice(0, 8).join('\n')}`);
    return '크래시 없음';
  },
};

/** 검사 순서. 근거도 이 순서로 이어 붙는다 */
const CHECKS: Check[] = [visible, notVisible, text, screen, network, pref, db, event, perf, noCrash];

async function retryUntil(timeoutMs: number, check: () => Promise<string | undefined>, failMsg: () => Promise<string> | string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await check().catch(() => undefined);
    if (ok !== undefined) return ok;
    if (Date.now() >= deadline) throw new StepFailure(await failMsg());
    await sleep(400);
  }
}

/** 단일 assertion 평가. 통과하면 근거 문자열, 실패하면 StepFailure. ctx.since 는 기기 시계 기준 (deviceTime) */
export async function evaluateAssertion(dev: DeviceAdb, app: string, a: Assertion, ctx: { since: number }): Promise<string> {
  const timeout = a.timeout ?? 3000;
  const env: CheckEnv = { dev, app, a, since: ctx.since, retry: (check, failMsg) => retryUntil(timeout, check, failMsg) };
  const evidence: string[] = [];
  for (const c of CHECKS) if (c.applies(a)) evidence.push(...[await c.run(env)].flat());
  return evidence.join(' · ');
}
