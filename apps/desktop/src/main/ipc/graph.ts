import { app, dialog } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as dl from '@droidlens/core';
import { dev, getWindow, inOrder, send, type Handle } from '../context';

/** 화면 지도: 보기·직접 조작 기록·자동 탐색·화면 이동·초기화·내보내기·가져오기 */

/** 기기를 오래 움직이는 화면 지도 작업 (자동 탐색·화면 이동). 한 번에 하나만 돌고, 그동안 직접 조작은 기록하지 않는다 */
let flowJob: { kind: 'explore' | 'navigate'; abort?: AbortController } | null = null;
const flowGuard = () => {
  if (flowJob) throw new Error(flowJob.kind === 'explore' ? '탐색 중입니다. 끝나거나 중지한 뒤 다시 시도하세요' : '화면 이동 중입니다. 끝난 뒤 다시 시도하세요');
};

/**
 * 화면 탭에서 직접 조작한 행동을 앞뒤 화면과 함께 지도에 기록.
 * 에이전트가 없으면 화면 확인이 1~2초씩 걸려 조작이 굼떠지고, 다른 앱 화면은 이 앱 지도와 상관없으므로 기록 없이 조작만 한다.
 * 조작은 바로 보내고 도착 화면 안정 대기·저장은 그 뒤에 한다. 기다리는 사이 다음 조작이 오면 그 기록은 버리고
 * (도착 화면이 이 행동의 결과가 아니게 되므로) 새 조작은 기록 없이 보낸다. 연달아 조작하는 동안은 기록을 건너뛰고 멈추면 다시 기록한다.
 * 기다리는 기록은 기기마다 따로 둔다 (다른 기기 조작이 이 기기의 기록을 버리지 않게)
 */
const recording = new Map<string, AbortController>();

interface ExploreRequest {
  maxDepth: number;
  fromCurrent?: boolean;
  startAt?: string;
  only?: dl.Interaction[];
  allowDanger?: boolean;
}

export function register(handle: Handle): void {
  handle('graphGet', async (pkg: string) => (await dl.ScreenGraph.open(pkg)).toJSON());
  // 화면마다 그 화면을 지난 기록·TC, 없으면 검증하지 않은 화면 (#131)
  handle('graphChecks', async (pkg: string) => dl.screenChecks((await dl.ScreenGraph.open(pkg)).toJSON(), await dl.loadScreenRecords(pkg)));
  handle('graphImage', async (pkg: string, file: string) => {
    const g = await dl.ScreenGraph.open(pkg);
    return `data:image/png;base64,${(await readFile(join(g.dir, basename(file)))).toString('base64')}`;
  });
  handle('graphRecord', async (s: string, pkg: string, action: dl.GraphAction) => {
    if (!['tap', 'longpress', 'swipe', 'key'].includes(action?.type)) throw new Error('기록할 수 없는 행동입니다');
    const d = dev(s);
    const pending = recording.get(s);
    if (pending) {
      pending.abort();
      await inOrder(() => dl.performAction(d, action, pkg));
      return { recorded: false as const, skipped: true };
    }
    const job = new AbortController();
    recording.set(s, job);
    try {
      const started = await inOrder(async () => {
        const before = flowJob || !(await dl.ensureAgent(d)) ? undefined : await dl.captureSnapshot(d, { screenshot: false });
        if (!before || before.screen.packageName !== pkg) {
          await dl.performAction(d, action, pkg);
          return undefined;
        }
        return dl.startTransition(d, await dl.ScreenGraph.open(pkg), action, before);
      });
      if (!started) return { recorded: false as const };
      const r = await started.finish(job.signal);
      return { recorded: true as const, from: r.from.id, to: r.to.id, isNew: r.to.visits === 1 };
    } catch (e) {
      if (job.signal.aborted) return { recorded: false as const, skipped: true };
      throw e;
    } finally {
      if (recording.get(s) === job) recording.delete(s);
    }
  });
  handle('graphRecordHere', async (s: string, pkg: string) => {
    const g = await dl.ScreenGraph.open(pkg);
    const n = await g.addSnapshot(await dl.captureSnapshot(dev(s)), dev(s));
    await g.save();
    return n.id;
  });
  handle('explore', async (s: string, pkg: string, req: ExploreRequest) => {
    flowGuard();
    const job = { kind: 'explore' as const, abort: new AbortController() };
    flowJob = job;
    try {
      const r = await dl.explore(dev(s), {
        packageName: pkg,
        maxDepth: req.maxDepth,
        relaunch: !req.fromCurrent,
        startAt: req.startAt,
        only: req.only,
        allowDanger: req.allowDanger,
        signal: job.abort.signal,
        onProgress: (e) => send('progress', { kind: 'explore', ...e }),
      });
      return { steps: r.steps, limited: r.limited, skipped: r.skipped, errors: r.errors, touched: r.touched, startScreen: r.startScreen };
    } finally {
      // 오류로 끝나도 '탐색 중' 상태가 남지 않게
      if (flowJob === job) flowJob = null;
    }
  });
  handle('exploreStop', async () => flowJob?.abort?.abort());
  handle('graphReset', async (pkg: string) => {
    if (flowJob) throw new Error('탐색 중에는 그래프를 초기화할 수 없습니다');
    await dl.ScreenGraph.reset(pkg);
  });
  /** 지도에 기록된 경로를 따라 기기를 그 화면으로 옮긴다 */
  handle('graphNavigate', async (s: string, pkg: string, target: string) => {
    flowGuard();
    const job = { kind: 'navigate' as const };
    flowJob = job;
    try {
      const g = await dl.ScreenGraph.open(pkg);
      const r = await dl.navigateTo(dev(s), g, target, (m) => send('progress', { kind: 'explore', message: m }));
      return { moved: r.moved, steps: r.moved ? (r.path?.length ?? 0) : 0 };
    } finally {
      if (flowJob === job) flowJob = null;
    }
  });
  handle('graphExport', async (pkg: string) => {
    const g = await dl.ScreenGraph.open(pkg);
    if (!g.nodes.size) throw new Error('내보낼 화면이 없습니다');
    const r = await dialog.showSaveDialog(getWindow()!, {
      defaultPath: join(app.getPath('downloads'), `${dl.safeName(pkg)}.droidlens-map.json`),
      filters: [{ name: 'DroidLens map', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return undefined;
    await writeFile(r.filePath, JSON.stringify(await g.exportBundle()));
    return r.filePath;
  });
  handle('graphImport', async (pkg: string) => {
    const r = await dialog.showOpenDialog(getWindow()!, { properties: ['openFile'], filters: [{ name: 'DroidLens map', extensions: ['json'] }] });
    const file = r.filePaths[0];
    if (r.canceled || !file) return undefined;
    if ((await stat(file)).size > 50 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (50MB 초과)');
    let bundle: unknown;
    try {
      bundle = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new Error('DroidLens 화면 지도 파일이 아닙니다');
    }
    return (await dl.ScreenGraph.open(pkg)).importBundle(bundle);
  });
}
