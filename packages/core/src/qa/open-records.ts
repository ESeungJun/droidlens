import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Scenario } from '../scenario.js';
import type { ScenarioData } from '../scenario-view.js';
import { droidlensHome, readJson } from '../workspace.js';

/**
 * 회차에서 끝나지 않은 TC 기록을 막힘으로 마무리한다 (#101).
 * 회차를 멈추거나 에이전트가 scenario_finish 없이 끝나면 기록을 연 MCP 서버도 같이 꺼져 기록이 "진행 중" 으로 남는다.
 * caseId 를 주면 그 TC 의 기록만. 최근 기록 limit 개만 본다(회차 기록은 늘 최근이다).
 * 돌려주는 값: 마무리한 기록의 TC 와 리포트 경로
 */
export async function closeOpenTcScenarios(
  planId: string,
  runId: string,
  reason: string,
  caseId?: string,
  limit = 300,
): Promise<{ case: string; report: string }[]> {
  const root = join(droidlensHome(), 'scenarios');
  if (!existsSync(root)) return [];
  const ids = (await readdir(root)).sort().reverse().slice(0, limit);
  const out: { case: string; report: string }[] = [];
  for (const id of ids) {
    const dir = join(root, id);
    const d = await readJson<ScenarioData>(join(dir, 'scenario.json')).catch(() => undefined);
    if (!d || d.finishedAt || !Array.isArray(d.steps)) continue;
    if (d.tc?.plan !== planId || d.tc.run !== runId || (caseId && d.tc.case !== caseId)) continue;
    const report = await new Scenario({ ...d, dir }).finish('blocked', reason).catch(() => undefined);
    if (report) out.push({ case: d.tc.case, report });
  }
  return out;
}
