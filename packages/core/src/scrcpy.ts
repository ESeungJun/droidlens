import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Socket, connect } from 'node:net';
import { DeviceAdb, sleep } from './adb.js';
import { droidlensHome } from './workspace.js';

/**
 * scrcpy 서버(v5) 기반 고프레임 미러링. 서버 jar만 기기에 올려 H.264 스트림을 받는다.
 * 디코딩은 호출부(데스크톱 렌더러의 WebCodecs)가 한다.
 *
 * 프로토콜 (forward 터널, control/audio 끔, device meta 끔):
 *   dummy byte(1) → codec id(u32 BE)
 *   → 세션 패킷 12B: byte0 MSB=1, [4..8) width, [8..12) height (회전 시마다)
 *   → 미디어 패킷: 12B 헤더 [MSB=0, bit62 config, bit61 key, 하위 61비트 PTS (u64)] + size(u32) + payload(Annex B)
 */

export const SCRCPY_VERSION = '5.0.1';
const REMOTE_JAR = '/data/local/tmp/droidlens-scrcpy-server.jar';

export function scrcpyServerPath(): string | undefined {
  const scriptDir = process.argv[1] ? dirname(process.argv[1]) : undefined;
  const candidates = [
    process.env.DROIDLENS_SCRCPY_SERVER,
    scriptDir && join(scriptDir, '..', 'scrcpy', 'scrcpy-server'),
    join(droidlensHome(), 'scrcpy', 'scrcpy-server'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

export interface MirrorOptions {
  /** 긴 변 최대 픽셀 (기본 1280) */
  maxSize?: number;
  maxFps?: number;
  bitRate?: number;
  serverPath?: string;
  logLevel?: 'verbose' | 'debug' | 'info' | 'warn' | 'error';
}

export interface MirrorHandlers {
  onSession(width: number, height: number): void;
  onPacket(p: { data: Buffer; config: boolean; key: boolean; pts: bigint }): void;
  onClose(reason?: string): void;
}

export interface Mirror {
  stop(): void;
}

const CODEC_H264 = 0x68323634;

export async function startMirror(dev: DeviceAdb, h: MirrorHandlers, opts: MirrorOptions = {}): Promise<Mirror> {
  const server = opts.serverPath ?? scrcpyServerPath();
  if (!server) throw new Error('scrcpy 서버 파일이 없습니다');
  await dev.raw(['push', server, REMOTE_JAR], { timeoutMs: 30_000 });

  const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
  const socketName = `scrcpy_${scid}`;
  const port = Number((await dev.text(['forward', 'tcp:0', `localabstract:${socketName}`])).trim());
  const args = [
    `CLASSPATH=${REMOTE_JAR}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_VERSION,
    `scid=${scid}`,
    `log_level=${opts.logLevel ?? 'warn'}`,
    'tunnel_forward=true',
    'audio=false',
    'control=false',
    'cleanup=true',
    'send_device_meta=false',
    'video_codec=h264',
    `max_size=${opts.maxSize ?? 1280}`,
    `max_fps=${opts.maxFps ?? 60}`,
    `video_bit_rate=${opts.bitRate ?? 8_000_000}`,
  ];
  const proc = dev.spawn(['shell', args.join(' ')]);
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  proc.stdout?.on('data', (d: Buffer) => (stderr += d.toString()));
  // adb 실행 실패 등은 error 이벤트로 온다. 리스너가 없으면 uncaught 예외로 프로세스가 죽는다
  proc.on('error', (e) => (stderr += e.message));

  let stopped = false;
  let sock: Socket | undefined;
  const cleanup = () => {
    sock?.destroy();
    proc.kill();
    dev.text(['forward', '--remove', `tcp:${port}`]).catch(() => undefined);
  };

  // 서버가 소켓을 열 때까지 재시도: forward는 상대가 없어도 연결되므로 dummy byte 수신으로 확인
  for (let i = 0; i < 40 && !sock; i++) {
    await sleep(250);
    if (proc.exitCode !== null) {
      cleanup();
      throw new Error(`scrcpy 서버가 종료됐습니다: ${stderr.trim().slice(0, 300)}`);
    }
    const s = await new Promise<Socket | undefined>((resolve) => {
      const c = connect(port, '127.0.0.1');
      const fail = () => {
        clearTimeout(timer);
        c.destroy();
        resolve(undefined);
      };
      const timer = setTimeout(fail, 1500);
      c.once('error', fail);
      c.once('close', fail);
      c.once('data', (d: Buffer) => {
        clearTimeout(timer);
        c.removeListener('close', fail);
        c.removeListener('error', fail);
        c.pause();
        if (d.length > 1) c.unshift(d.subarray(1)); // dummy byte 뒤 데이터는 되돌린다
        resolve(c);
      });
    });
    if (s) sock = s;
  }
  if (!sock) {
    cleanup();
    throw new Error(`scrcpy 서버에 연결하지 못했습니다 ${stderr.trim().slice(0, 300)}`);
  }

  const closed = (reason?: string) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    h.onClose(reason);
  };

  // 스트림 파서
  let buf: Buffer = Buffer.alloc(0);
  let codecRead = false;
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    try {
      for (;;) {
        if (!codecRead) {
          if (buf.length < 4) return;
          const codec = buf.readUInt32BE(0);
          if (codec !== CODEC_H264) throw new Error(`지원하지 않는 코덱: 0x${codec.toString(16)}`);
          codecRead = true;
          buf = buf.subarray(4);
          continue;
        }
        if (buf.length < 12) return;
        if (buf[0] & 0x80) {
          // 세션 패킷
          h.onSession(buf.readUInt32BE(4), buf.readUInt32BE(8));
          buf = buf.subarray(12);
          continue;
        }
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) return;
        const head = buf.readBigUInt64BE(0);
        h.onPacket({
          data: Buffer.from(buf.subarray(12, 12 + size)),
          config: (head & (1n << 62n)) !== 0n,
          key: (head & (1n << 61n)) !== 0n,
          pts: head & ((1n << 61n) - 1n),
        });
        buf = buf.subarray(12 + size);
      }
    } catch (e) {
      closed((e as Error).message);
    }
  });
  // 연결 확인 때 붙였던 error 리스너는 떼었으므로, 미러링 중 ECONNRESET 등이 프로세스를 죽이지 않게 다시 붙인다
  sock.on('error', (e) => closed(e.message));
  sock.on('close', () => closed(stderr.trim().slice(-500) || undefined));
  sock.resume();

  return {
    stop() {
      stopped = true;
      cleanup();
    },
  };
}
