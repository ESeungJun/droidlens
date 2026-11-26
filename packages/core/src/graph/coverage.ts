/**
 * 화면별 검증 기록 찾기 (#131): 지도 화면마다 그 화면을 지난 시나리오 기록과 QA TC 를 모으고,
 * 아무 기록도 없는 화면은 "검증하지 않은 화면" 으로 본다. 자동 탐색이 찾은 새 화면이 TC 를 더 만들 후보가 되게 한다.
 *
 * 같은 화면 판단 (앞에서부터):
 * 1. 단계의 screenId 가 지도 화면 id 와 같다 (Activity@시그니처, 시나리오 단계와 지도가 같은 값을 쓴다)
 * 2. screenId 가 없는 예전 기록: 단계의 Activity 를 가진 지도 화면이 하나뿐이면 그 화면
 * 3. 연결에 붙은 TC (TcPath): 그 연결의 양 끝 화면
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EdgeTc, GraphData } from '../graph-model.js';
import { CASE_ID, PLAN_ID } from '../qa/plan.js';
import { droidlensHome, readJson } from '../workspace.js';

/** 화면 판단에 쓰는 기록 요약 */
export interface ScreenRecord {
  id: string;
  name: string;
  verdict?: string;
  tc?: { plan: string; case: string };
  steps: { screenId?: string; screen?: string }[];
}

export interface ScreenCheck {
  verified: boolean;
  /** 이 화면을 지난 기록 */
  records: { id: string; name: string; verdict?: string }[];
  /** 이 화면을 지난 TC (기록의 TC 와 연결에 붙은 TC). 같은 TC 는 하나 */
  tcs: { plan: string; case: string; verdict?: string }[];
}

const str = (v: unknown): v is string => typeof v === 'string';

/** 지도 화면마다 지난 기록·TC */
export function screenChecks(g: Pick<GraphData, 'nodes' | 'edges'>, records: ScreenRecord[]): Record<string, ScreenCheck> {
  const out: Record<string, ScreenCheck> = {};
  const tcSeen = new Map<string, Set<string>>();
  for (const n of g.nodes) {
    out[n.id] = { verified: false, records: [], tcs: [] };
    tcSeen.set(n.id, new Set());
  }
  const byActivity = new Map<string, string[]>();
  for (const n of g.nodes) byActivity.set(n.activity, [...(byActivity.get(n.activity) ?? []), n.id]);
  const addTc = (node: string, t: { plan: string; case: string; verdict?: string }) => {
    const c = out[node];
    const seen = tcSeen.get(node);
    if (!c || !seen || seen.has(`${t.plan}/${t.case}`)) return;
    seen.add(`${t.plan}/${t.case}`);
    c.tcs.push({ plan: t.plan, case: t.case, verdict: t.verdict });
  };

  for (const r of records) {
    const hit = new Set<string>();
    for (const s of r.steps) {
      if (s.screenId && out[s.screenId]) hit.add(s.screenId);
      else if (!s.screenId && s.screen) {
        const same = byActivity.get(s.screen.split(' / ')[0]) ?? [];
        if (same.length === 1) hit.add(same[0]);
      }
    }
    for (const id of hit) {
      out[id].records.push({ id: r.id, name: r.name, verdict: r.verdict });
      if (r.tc) addTc(id, { ...r.tc, verdict: r.verdict });
    }
  }
  for (const e of g.edges) {
    for (const t of (e.tcs ?? []) as EdgeTc[]) {
      addTc(e.from, t);
      addTc(e.to, t);
    }
  }
  for (const c of Object.values(out)) {
    c.tcs.sort((a, b) => a.case.localeCompare(b.case) || a.plan.localeCompare(b.plan));
    c.verified = c.records.length > 0 || c.tcs.length > 0;
  }
  return out;
}

/**
 * 시나리오 기록 폴더에서 그 앱의 기록만 읽는다 (최근 limit 개). 폴더 바로 아래 실제 폴더만 보고, 형식이 틀린 기록은 건너뛴다
 */
export async function loadScreenRecords(packageName: string, limit = 500): Promise<ScreenRecord[]> {
  const root = join(droidlensHome(), 'scenarios');
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const ids = dirs
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);
  const out: ScreenRecord[] = [];
  for (const id of ids) {
    const d = await readJson<Record<string, unknown>>(join(root, id, 'scenario.json')).catch(() => undefined);
    if (!d || d.packageName !== packageName || !str(d.name) || !Array.isArray(d.steps)) continue;
    const tc = d.tc as { plan?: unknown; case?: unknown } | undefined;
    out.push({
      id,
      name: d.name,
      verdict: str(d.verdict) ? d.verdict : undefined,
      tc: tc && str(tc.plan) && str(tc.case) && PLAN_ID.test(tc.plan) && CASE_ID.test(tc.case) ? { plan: tc.plan, case: tc.case } : undefined,
      steps: (d.steps as unknown[])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({ screenId: str(s.screenId) ? s.screenId : undefined, screen: str(s.screen) ? s.screen : undefined })),
    });
  }
  return out;
}
