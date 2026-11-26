import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Scenario } from '../scenario.js';
import type { ScenarioData } from '../scenario-view.js';
import { droidlensHome, readJson } from '../workspace.js';
import { maskScenario } from './export.js';
import { scenarioDirReal } from './scenario-dir.js';

export interface CloseOpenOptions {
  /** 그 TC 의 기록만 */
  caseId?: string;
  /** 이 시각(ms) 뒤에 시작한 기록만. 이 실행이 띄운 기록만 닫고, 같은 회차를 밖에서 이어 적는 기록은 두려고 (#113) */
  since?: number;
  /** 최근 기록 몇 개까지 볼지 (회차 기록은 늘 최근이다) */
  limit?: number;
}

/**
 * 회차에서 끝나지 않은 TC 기록을 막힘으로 마무리한다 (#101).
 * 회차를 멈추거나 에이전트가 scenario_finish 없이 끝나면 기록을 연 MCP 서버도 같이 꺼져 기록이 "진행 중" 으로 남는다.
 * 기록 폴더는 손댄 것일 수 있다: 시나리오 폴더 바로 아래 실제 폴더이고 형식이 맞는 기록만 마무리한다 (#113).
 * 돌려주는 값: 마무리한 기록의 TC 와 리포트 경로
 */
export async function closeOpenTcScenarios(
  planId: string,
  runId: string,
  reason: string,
  opts: CloseOpenOptions = {},
): Promise<{ case: string; report: string }[]> {
  const { caseId, since, limit = 300 } = opts;
  const root = join(droidlensHome(), 'scenarios');
  if (!existsSync(root)) return [];
  const ids = (await readdir(root)).sort().reverse().slice(0, limit);
  const out: { case: string; report: string }[] = [];
  for (const id of ids) {
    const raw = await readJson<ScenarioData>(join(root, id, 'scenario.json')).catch(() => undefined);
    if (!raw || raw.finishedAt) continue;
    if (raw.tc?.plan !== planId || raw.tc.run !== runId || (caseId && raw.tc.case !== caseId)) continue;
    if (since !== undefined && !(raw.startedAt >= since)) continue;
    const dir = await scenarioDirReal(join(root, id));
    const d = dir && maskScenario({ ...raw, dir }, undefined);
    if (!d) continue;
    const report = await new Scenario(d).finish('blocked', reason).catch(() => undefined);
    if (report) out.push({ case: raw.tc.case, report });
  }
  return out;
}
