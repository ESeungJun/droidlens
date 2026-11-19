import { join } from 'node:path';
import * as dl from '@droidlens/core';
import { dev, type Handle } from '../context';

/**
 * 기기별 녹화. 녹화 상태는 여기가 기준이고 화면은 recordStatus 로 다시 읽는다 (탭을 옮기거나 기기를 바꿔도 잃지 않게).
 * screenrecord 가 180초 제한으로 먼저 끝나도 기기에 파일이 남아 있으므로, 중지하면 그때까지 녹화된 파일을 받아 온다
 */
const recs = new Map<string, dl.Recording>();

export function register(handle: Handle): void {
  handle('recordStatus', async (s: string) => recs.get(s)?.startedAt ?? null);
  handle('recordStart', async (s: string) => {
    if (recs.has(s)) throw new Error('이미 녹화 중입니다');
    const r = dl.startRecording(dev(s));
    recs.set(s, r);
    return r.startedAt;
  });
  handle('recordStop', async (s: string) => {
    const r = recs.get(s);
    if (!r) throw new Error('녹화 중이 아닙니다');
    recs.delete(s);
    const dir = await dl.ensureDir('recordings');
    return r.stop(join(dir, `${dl.timestamp()}_record.mp4`));
  });
}

/**
 * 앱 종료 정리. 녹화는 기기 쪽 screenrecord 를 멈추고, 받아 올 수 없게 된 파일은 기기에서 지운다 (adb 셸은 앱이 끝나도 마저 돈다).
 * 다른 녹화(MCP record_start 등)는 두도록 우리 파일 경로로 좁힌다. 셸 자신의 명령줄에도 경로가 들어 있어 ^screenrecord 로 묶고,
 * toybox pkill 은 -INT 와 -f 를 함께 쓰면 자기 셸까지 끊어서 신호는 -l INT 로 준다 (LG G8·Flip3 에서 확인)
 */
export function stop(): void {
  for (const [s, r] of recs) {
    const mine = dl.quoteShell(`^screenrecord .*${r.remotePath}$`);
    dev(s).spawn(['shell', `pkill -l INT -f ${mine}; sleep 1; rm -f ${dl.quoteShell(r.remotePath)}`]).on('error', () => undefined);
  }
  recs.clear();
}
