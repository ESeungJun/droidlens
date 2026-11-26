import { shell } from 'electron';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import * as dl from '@droidlens/core';
import type { Handle } from '../context';

/** DroidLens 데이터 폴더(~/.droidlens)의 파일: 열기·폴더에서 보기·시나리오 리포트 목록·지우기·이미지·기준 이미지 받아들이기 */

/** 심볼릭 링크를 풀어 실제 위치로 비교한다 (데이터 폴더 안의 링크로 밖을 가리키지 못하게). 없는 경로는 그대로 */
const realPath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** 렌더러가 넘긴 경로는 DroidLens 데이터 폴더 안쪽만 허용 (openPath는 실행 파일도 열 수 있으므로) */
function insideHome(p: string): string {
  const full = realPath(resolve(p));
  const home = realPath(resolve(dl.droidlensHome()));
  if (full !== home && !full.startsWith(home + sep)) throw new Error('DroidLens 데이터 폴더 밖의 경로는 열 수 없습니다');
  return full;
}

/** <home>/qa/<계획>/runs/<회차>/results.xlsx 인지 */
function isRunXlsx(full: string): boolean {
  const qa = realPath(resolve(dl.droidlensHome(), 'qa')) + sep;
  if (!full.startsWith(qa)) return false;
  const parts = full.slice(qa.length).split(sep);
  return parts.length === 4 && parts[1] === 'runs' && parts[3] === 'results.xlsx';
}

export function register(handle: Handle): void {
  handle('reveal', async (p: string) => shell.showItemInFolder(insideHome(p)));
  handle('openPath', async (p: string) => {
    const full = insideHome(p);
    // .xlsx 는 매크로·외부 연결 위험이 있어 우리가 만든 회차 결과표만 연다 (#98)
    if (!/\.(html|png|mp4|json|mmd|apk)$/i.test(full) && !isRunXlsx(full) && full !== resolve(dl.droidlensHome())) throw new Error('열 수 없는 파일 형식입니다');
    return shell.openPath(full);
  });
  handle('home', async () => dl.droidlensHome());
  handle('scenarios', async () => {
    const fs = await import('node:fs/promises');
    const dir = await dl.ensureDir('scenarios');
    const ids = (await fs.readdir(dir)).sort().reverse();
    const out = [];
    for (const id of ids.slice(0, 100)) {
      const d = await dl.readJson<dl.ScenarioData>(join(dir, id, 'scenario.json'));
      if (d) out.push(d);
    }
    return out;
  });
  handle('scenarioDelete', async (ids: string[]) => {
    if (!Array.isArray(ids)) throw new Error('잘못된 요청입니다');
    const fs = await import('node:fs/promises');
    const dir = await dl.ensureDir('scenarios');
    for (const id of ids) {
      // 시나리오 폴더 바로 아래의 기록만 지운다 (경로 조작 방지)
      if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id.startsWith('.')) throw new Error(`잘못된 시나리오 id: ${id}`);
      // 에이전트가 아직 기록 중인 리포트를 지우면 다음 단계 저장이 실패한다.
      // 끝나지 않았어도 1시간이 지났으면 에이전트가 중간에 멈춘 것으로 보고 지울 수 있게 한다
      const d = await dl.readJson<dl.ScenarioData>(join(dir, id, 'scenario.json'));
      if (d && !d.finishedAt && Date.now() - d.startedAt < 60 * 60 * 1000) throw new Error('진행 중인 시나리오는 지울 수 없습니다');
      await fs.rm(join(dir, id), { recursive: true, force: true });
    }
  });
  /** 스크린샷 비교에 실패한 단계의 지금 화면을 새 기준 이미지로 받아들인다 */
  handle('baselineAccept', async (dir: string, file: string, app: string, name: string) => {
    // 리포트가 남긴 지금 화면(step-NNN-actual.png)만 기준으로 받는다
    if (!/^step-\d+-actual\.png$/.test(basename(file))) throw new Error('기준으로 삼을 수 있는 파일이 아닙니다');
    const png = await readFile(insideHome(join(dir, basename(file))));
    if (!png.subarray(0, dl.PNG_MAGIC.length).equals(dl.PNG_MAGIC)) throw new Error('PNG 이미지가 아닙니다');
    return dl.saveBaseline(app, name, png);
  });
  handle('scenarioImage', async (dir: string, file: string) => {
    // 리포트가 남긴 단계 스크린샷만 읽는다
    if (!/^step-\d+(-actual)?\.png$/.test(basename(file))) throw new Error('리포트 이미지가 아닙니다');
    const png = await readFile(insideHome(join(dir, basename(file))));
    if (!png.subarray(0, dl.PNG_MAGIC.length).equals(dl.PNG_MAGIC)) throw new Error('PNG 이미지가 아닙니다');
    return `data:image/png;base64,${png.toString('base64')}`;
  });
}
