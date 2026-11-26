import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as dl from '@droidlens/core';
import { dev, send, type Handle } from '../context';

/** 시나리오 스크립트: 목록·읽기·쓰기·지우기·실행·중지 (한 번에 하나 실행) */
let scriptAbort: AbortController | null = null;
/** 스크립트 경로는 scripts 폴더 안의 파일 이름으로만 받는다 */
const scriptFile = async (name: string) => join(await dl.scriptsDir(), basename(name));

export function register(handle: Handle): void {
  handle('scriptsList', async () => {
    const dir = await dl.scriptsDir();
    const files = await dl.collectScripts(dir);
    return Promise.all(
      files.map(async (f) => {
        try {
          const s = await dl.loadScript(f);
          return { file: basename(f), name: s.name, app: s.app, steps: s.steps.length };
        } catch (e) {
          return { file: basename(f), name: basename(f), error: (e as Error).message };
        }
      }),
    );
  });
  handle('scriptRead', async (name: string) => readFile(await scriptFile(name), 'utf8'));
  handle('scriptWrite', async (name: string, yaml: string) => {
    const script = dl.parseScript(yaml); // 형식 오류면 저장하지 않고 에러
    const file = name ? basename(name) : `${dl.safeName(script.name)}.yaml`;
    await import('node:fs/promises').then(async (fs) => fs.writeFile(await scriptFile(file), yaml));
    return file;
  });
  handle('scriptDelete', async (name: string) => import('node:fs/promises').then(async (fs) => fs.unlink(await scriptFile(name))));
  handle('scriptRun', async (s: string, names: string[]) => {
    scriptAbort?.abort();
    scriptAbort = new AbortController();
    const signal = scriptAbort.signal;
    const results = [];
    for (const [i, name] of names.entries()) {
      if (signal.aborted) break;
      const path = await scriptFile(name);
      send('script:progress', { kind: 'script', file: name, index: i, total: names.length });
      try {
        const r = await dl.runScript(dev(s), await dl.loadScript(path), {
          sourcePath: path,
          signal,
          onStep: (e) => send('script:progress', { kind: 'step', file: name, ...e }),
        });
        results.push({ file: name, verdict: r.verdict, passed: r.passed, failed: r.failed, skipped: r.skipped, durationMs: r.durationMs, report: r.report });
      } catch (e) {
        results.push({ file: name, verdict: 'blocked', error: (e as Error).message });
      }
    }
    scriptAbort = null;
    return results;
  });
  handle('scriptStop', async () => scriptAbort?.abort());
}
