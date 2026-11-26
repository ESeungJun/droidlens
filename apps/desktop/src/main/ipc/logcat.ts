import * as dl from '@droidlens/core';
import { dev, send, type Handle } from '../context';

/** logcat 스트림 (한 번에 하나) */
let logStream: { stop(): void } | null = null;
/** 가장 최근에 요청된 로그 스트림 id (렌더러가 정한다). pid 를 찾는 사이 중지·재시작이 오면 바뀌어 이전 요청은 스트림을 열지 않는다 */
let logWant: number | null = null;

export function register(handle: Handle): void {
  handle('logcatStart', async (s: string, pkg: string | undefined, id: number) => {
    logWant = id;
    logStream?.stop();
    logStream = null;
    const pid = pkg ? await dl.pidOf(dev(s), pkg) : undefined;
    if (logWant !== id) return null;
    if (pkg && !pid) {
      logWant = null;
      throw new Error(`${pkg} 프로세스가 실행 중이 아닙니다`);
    }
    let batch: dl.LogLine[] = [];
    const flush = () => {
      if (batch.length) send('logcat', { id, lines: batch.splice(0) });
    };
    const timer = setInterval(flush, 200);
    const st = dl.streamLogcat(dev(s), (l) => batch.push(l), { pid });
    const stream = {
      stop: () => {
        clearInterval(timer);
        st.stop();
      },
    };
    st.proc.on('error', () => undefined);
    // 기기 연결이 끊기는 등으로 스트림이 스스로 끝나면 화면에 알린다 (중지를 눌러 끝난 것은 알리지 않는다)
    st.proc.on('close', () => {
      clearInterval(timer);
      if (logStream !== stream) return;
      flush();
      logStream = null;
      logWant = null;
      send('logcat:closed', { id });
    });
    logStream = stream;
    return pid ?? null;
  });
  /** id 를 주면 그 스트림이 아직 최신일 때만 멈춘다 */
  handle('logcatStop', async (id?: number) => {
    if (id !== undefined && id !== logWant) return;
    logWant = null;
    logStream?.stop();
    logStream = null;
  });
}

/** 앱 종료 정리 */
export function stop(): void {
  logWant = null;
  logStream?.stop();
  logStream = null;
}
