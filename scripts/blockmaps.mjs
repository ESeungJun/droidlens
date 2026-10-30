// 릴리스 첨부 파일마다 부분 업데이트용 조각 정보(<파일>.blockmap)를 만든다.
// 앱 업데이터(apps/desktop/src/main/delta.ts)가 이것으로 달라진 조각만 받는다.
// 사용: node scripts/blockmaps.mjs <파일>...
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = createRequire(fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url)));
// app-builder-lib 은 electron-builder 의 의존성이라 그쪽에서 찾는다
const builder = createRequire(desktop.resolve('electron-builder'));
const { buildBlockMap } = builder('app-builder-lib/out/targets/blockmap/blockmap.js');

const files = process.argv.slice(2);
if (!files.length) throw new Error('blockmap 을 만들 파일이 없습니다');
for (const f of files) {
  await buildBlockMap(f, 'gzip', `${f}.blockmap`);
  console.log(`${f}.blockmap`);
}
