// 스크린샷 축소와 좌표 배율 안내
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { downscaleToJpegInfo, downscaleToJpeg, imageScaleNote } from '../dist/image.js';

const png = (w, h) => PNG.sync.write(new PNG({ width: w, height: h }));

test('downscaleToJpegInfo: 긴 변 900 으로 줄이고 원본·결과 크기를 돌려준다', () => {
  const r = downscaleToJpegInfo(png(1080, 2400));
  assert.deepEqual([r.width, r.height, r.srcWidth, r.srcHeight], [405, 900, 1080, 2400]);
  assert.ok(r.data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'JPEG');
  assert.ok(downscaleToJpeg(png(1080, 2400)).equals(r.data));
});

test('imageScaleNote: 줄였으면 배율, 안 줄였으면 그대로', () => {
  assert.equal(
    imageScaleNote(downscaleToJpegInfo(png(1080, 2400))),
    '원본 1080x2400 · 이미지 405x900 · tap·swipe 좌표(기기 픽셀) = 이미지 좌표 × 2.667',
  );
  assert.match(imageScaleNote(downscaleToJpegInfo(png(2400, 1080))), /이미지 900x405 .* × 2\.667/);
  assert.equal(imageScaleNote(downscaleToJpegInfo(png(320, 480))), '이미지 320x480 = 기기 픽셀 (tap·swipe 좌표로 그대로 쓴다)');
});
