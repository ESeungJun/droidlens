import { app } from 'electron';
import { existsSync } from 'node:fs';
import * as dl from '@droidlens/core';
import { debug, dev, resourcePath, send, type Handle } from '../context';

/** 고프레임 미러링 (scrcpy) */
let mirror: { serial: string; m: dl.Mirror } | null = null;
/**
 * 가장 최근에 요청된 미러링 세션 id (렌더러가 정한다). 연결에 수~십수 초가 걸리는 동안 중지·재시작이 오면
 * 이 값이 바뀌므로, 연결이 끝났을 때 자기 id 가 아니면 바로 멈춘다. 이벤트에도 id 를 실어 렌더러가 이전 세션 패킷을 버리게 한다
 */
let mirrorWant: number | null = null;
const scrcpyServer = () =>
  app.isPackaged ? resourcePath('scrcpy', 'scrcpy-server') : resourcePath('vendor', 'scrcpy', 'scrcpy-server');

export function register(handle: Handle): void {
  handle('mirrorStart', async (s: string, maxSize: number | undefined, id: number) => {
    debug('mirrorStart', s, maxSize, id);
    mirrorWant = id;
    mirror?.m.stop();
    mirror = null;
    if (!existsSync(scrcpyServer())) throw new Error('scrcpy 서버 파일이 없습니다 (node scripts/fetch-scrcpy.mjs)');
    const m = await dl.startMirror(
      dev(s),
      {
        onSession: (width, height) => send('mirror:session', { id, width, height }),
        // Buffer는 구조화 복제로 Uint8Array가 된다
        onPacket: (p) => (debug('packet', p.data.length, p.config ? 'config' : '', p.key ? 'key' : ''), send('mirror:packet', { id, data: p.data, config: p.config, key: p.key, pts: Number(p.pts) })),
        onClose: (reason) => {
          if (mirror?.m === m) mirror = null;
          send('mirror:closed', { id, reason });
        },
      },
      { serverPath: scrcpyServer(), maxSize: maxSize ?? 1280 },
    );
    // 연결하는 사이 중지되거나 다른 세션이 시작됐으면 이 세션은 버린다
    if (mirrorWant !== id) {
      m.stop();
      return false;
    }
    mirror = { serial: s, m };
    debug('mirror connected');
    return true;
  });
  /** id 를 주면 그 세션이 아직 최신일 때만 멈춘다 (늦게 온 이전 화면의 정리가 새 세션을 끊지 않게) */
  handle('mirrorStop', async (id?: number) => {
    debug('mirrorStop', id);
    if (id !== undefined && id !== mirrorWant) return;
    mirrorWant = null;
    mirror?.m.stop();
    mirror = null;
  });
}

/** 앱 종료 정리 */
export function stop(): void {
  mirrorWant = null;
  mirror?.m.stop();
  mirror = null;
}
