import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from './api';

/**
 * scrcpy H.264 스트림을 WebCodecs로 디코딩해 canvas에 그린다.
 * 설정 패킷(SPS/PPS)은 다음 키프레임 앞에 붙여 Annex B 형식으로 넣는다 (description 없이 configure하면 Annex B로 처리).
 */

export interface MirrorHandle {
  canvas: HTMLCanvasElement | null;
  videoSize: { width: number; height: number } | null;
}

/** SPS NAL에서 avc1.PPCCLL 코덱 문자열을 만든다 */
function codecFromConfig(data: Uint8Array): string {
  for (let i = 0; i + 4 < data.length; i++) {
    const startCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (!startCode3) continue;
    const nal = data[i + 3];
    if ((nal & 0x1f) === 7) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return 'avc1.42E01F';
}

export const MirrorCanvas = forwardRef<
  MirrorHandle,
  {
    serial: string;
    maxSize?: number;
    onError(msg: string): void;
    onFps?(fps: number): void;
  } & React.CanvasHTMLAttributes<HTMLCanvasElement>
>(function MirrorCanvas({ serial, maxSize, onError, onFps, ...canvasProps }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [status, setStatus] = useState('연결 중…');

  useImperativeHandle(ref, () => ({ canvas: canvasRef.current, videoSize: size }), [size]);

  useEffect(() => {
    let decoder: VideoDecoder | null = null;
    let pendingConfig: Uint8Array | null = null;
    let configured = false;
    let frames = 0;
    let decodedAny = false;
    let closed = false;
    const fpsTimer = setInterval(() => {
      onFps?.(frames);
      frames = 0;
    }, 1000);

    const newDecoder = () => {
      decoder?.close();
      decoder = new VideoDecoder({
        output: (frame) => {
          const c = canvasRef.current;
          if (c) {
            if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
              c.width = frame.displayWidth;
              c.height = frame.displayHeight;
            }
            c.getContext('2d')!.drawImage(frame, 0, 0);
            frames++;
            decodedAny = true;
          }
          frame.close();
        },
        error: (e) => onError(`디코더 오류: ${e.message}`),
      });
      configured = false;
    };
    newDecoder();

    const offSession = api.onMirrorSession((s) => {
      setSize(s);
      setStatus('');
    });
    const offPacket = api.onMirrorPacket((p) => {
      if (!decoder || decoder.state === 'closed') return;
      if (p.config) {
        pendingConfig = p.data;
        // 회전 등으로 설정이 바뀌면 디코더를 새로 구성
        newDecoder();
        decoder.configure({ codec: codecFromConfig(p.data), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        configured = true;
        return;
      }
      if (!configured) return;
      let data = p.data;
      if (p.key && pendingConfig) {
        const merged = new Uint8Array(pendingConfig.length + data.length);
        merged.set(pendingConfig);
        merged.set(data, pendingConfig.length);
        data = merged;
        pendingConfig = null;
      }
      // 디코더가 밀리면 다음 키프레임까지 버려 지연이 쌓이지 않게 한다
      if (decoder.decodeQueueSize > 8 && !p.key) return;
      decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data }));
    });
    const offClosed = api.onMirrorClosed((c) => {
      if (!closed) onError(`미러링이 끊겼습니다${c.reason ? `: ${c.reason}` : ''}`);
    });

    // 화면이 정지해 있으면 scrcpy는 첫 프레임을 보내지 않으므로, 디코딩 전까지 스크린샷 한 장을 먼저 그려 둔다
    api
      .screenshot(serial)
      .then((src) => {
        const img = new Image();
        img.onload = () => {
          const c = canvasRef.current;
          if (!c || decodedAny || closed) return;
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d')!.drawImage(img, 0, 0);
          setSize((cur) => cur ?? { width: img.naturalWidth, height: img.naturalHeight });
          setStatus('');
        };
        img.src = src;
      })
      .catch(() => undefined);

    api.mirrorStart(serial, maxSize).catch((e) => onError((e as Error).message));

    return () => {
      closed = true;
      clearInterval(fpsTimer);
      offSession();
      offPacket();
      offClosed();
      api.mirrorStop().catch(() => undefined);
      decoder?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, maxSize]);

  return (
    <>
      <canvas ref={canvasRef} {...canvasProps} style={{ ...canvasProps.style, display: size ? 'block' : 'none' }} />
      {status && <div className="faint">{status}</div>}
    </>
  );
});
