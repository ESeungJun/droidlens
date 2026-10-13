import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

/**
 * PNG를 긴 변 maxEdge 이하로 축소해 JPEG로 인코딩한다. 순수 JS라 macOS/Windows/Linux 모두 동작.
 * 에이전트에게 보낼 스크린샷 토큰을 줄이는 용도 (1080×2400 PNG ~2MB → 900px JPEG ~60KB).
 */
export function downscaleToJpeg(png: Buffer, maxEdge = 900, quality = 70): Buffer {
  const src = PNG.sync.read(png);
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.alloc(w * h * 4);
  const step = 1 / scale;
  // 박스 필터: 원본에서 대응 영역의 평균
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * step);
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.floor((y + 1) * step)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * step);
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.floor((x + 1) * step)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: out, width: w, height: h }, quality).data);
}
