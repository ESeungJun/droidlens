// 디자인 비교 (#77): Figma 커넥터 응답 파싱, 화면 재기(글자 크기·색), 짝짓기, 차이 판정, 결과 파일을 시험한다.
// 픽스처는 커넥터 응답 형식만 흉내 낸 합성 화면이다 (실제 시안은 넣지 않는다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
// 개발 기기에 Figma 토큰이 있어도 시험은 네트워크를 쓰지 않는다
delete process.env.FIGMA_TOKEN;
delete process.env.DROIDLENS_FIGMA_TOKEN;
after(() => rmSync(home, { recursive: true, force: true }));

const d = await import('../dist/design/index.js');
const qa = await import('../dist/qa/index.js');
const { parseHierarchyXml } = await import('../dist/hierarchy.js');

const FIGMA = 'https://www.figma.com/design/AbCdEf123/Sample?node-id=1-2';

// 합성 시안 (샘플 앱 DesignActivity 와 같은 배치). get_metadata 응답 형식: 앞뒤 안내 글, 자식 좌표는 부모 기준, group 은 좌표 공간을 만들지 않음, instance 는 자식 없음
const METADATA = readFileSync(join(import.meta.dirname, 'fixtures', 'design-settings.metadata.txt'), 'utf8');

// get_design_context 응답 형식: React + Tailwind, 값은 숫자로, 색은 var(--x,#hex) 로도 온다
const CODE = readFileSync(join(import.meta.dirname, 'fixtures', 'design-settings.code.txt'), 'utf8');

const guideOf = () => d.buildDesignGuide({ figma: FIGMA, metadata: METADATA, code: [CODE], example: ['1:8'] }).guide;

test('메타데이터·디자인 코드를 합쳐 가이드를 만든다', () => {
  const { guide, notes } = d.buildDesignGuide({ figma: FIGMA, metadata: METADATA, code: [CODE], example: ['1:8'] });
  assert.deepEqual(guide.frame, { id: '1:2', name: '설정 화면', width: 360, height: 640 });
  assert.equal(guide.scale, 1);
  const el = Object.fromEntries(guide.elements.map((e) => [e.id, e]));
  assert.equal(el['1:2'], undefined, '프레임 자신은 요소에서 뺀다');
  assert.deepEqual(el['1:3'].rect, { x: 20, y: 56, w: 40, h: 28 }, '프레임의 캔버스 위치를 빼고 0,0 기준');
  assert.deepEqual(el['1:3'].font, { size: 20, weight: 600, lineHeight: 28 });
  assert.equal(el['1:3'].behind, '#ffffff');
  assert.deepEqual(el['1:5'].rect, { x: 20, y: 120, w: 80, h: 21 }, '자식은 부모 기준');
  assert.equal(el['1:5'].text, '알림 받기');
  assert.equal(el['1:5'].color, '#191919', 'var(--x,#hex) 는 대체 값');
  assert.deepEqual(el['1:5'].font, { size: 15, weight: 500, lineHeight: 21 }, '안쪽 래퍼(id 없음)의 클래스도 그 노드 것');
  assert.deepEqual(el['1:8'].rect, { x: 280, y: 120, w: 60, h: 21 }, 'group 자식은 group 의 부모 기준');
  assert.equal(el['1:8'].example, true);
  assert.deepEqual(el['1:4'].padding, [8, 20, 8, 20]);
  assert.equal(el['1:4'].gap, 4);
  assert.equal(el['1:9'].radius, 8);
  assert.equal(el['1:10'].color, '#ffffff');
  assert.equal(el['1:10'].behind, '#ff5a00', '가장 가까운 조상의 배경');
  assert.equal(el['I1:11;2:1'].text, '홈');
  assert.equal(el['I1:11;2:1'].rect, undefined, '인스턴스 안은 위치를 모른다');
  assert.ok(notes.some((n) => n.includes('위치를 모릅니다')));
});

test('큰 프레임은 360 폭으로 맞추고, 노드가 없으면 던진다', () => {
  assert.equal(d.defaultScale(360), 1);
  assert.equal(d.defaultScale(1080), 0.333);
  assert.throws(() => d.buildDesignGuide({ figma: FIGMA, metadata: '노드 없음' }), /Figma 노드/);
  assert.equal(d.cssColor('#abc'), '#aabbcc');
  assert.equal(d.cssColor('#11223380'), undefined, '반투명은 모름');
});

test('ΔE2000 은 같은 색 0, 검정-흰색 100', () => {
  assert.equal(d.deltaE2000([25, 25, 25], [25, 25, 25]), 0);
  assert.ok(Math.abs(d.deltaE2000([0, 0, 0], [255, 255, 255]) - 100) < 0.1);
  assert.ok(d.deltaE2000(d.hexToRgb('#191919'), d.hexToRgb('#1b1b1b')) < 3);
});

// ---------- 합성 화면 ----------

const DENSITY = 480;
const K = DENSITY / 160;
const W = 360 * K;
const H = 640 * K;

/**
 * texts: [{ text, x, y, w, h (dp), size (sp), color, bold?, lines?: [줄 수, 줄 높이 dp], icon?: { color, w (dp) }, desc?, scrollable? }]
 * boxes: [{ x, y, w, h, color, radius? (dp) }]
 * 글자 획은 세로 막대로 흉내 낸다: 막대 폭은 글자 크기의 0.09배(보통)·0.14배(굵게)
 */
function makeScreen(texts, boxes = [], opt = {}) {
  const sw = opt.width ?? W;
  const sh = opt.height ?? H;
  const png = new PNG({ width: sw, height: sh });
  const put = (x, y, [r, g, b], a = 1) => {
    if (x < 0 || y < 0 || x >= sw || y >= sh) return;
    const i = (y * sw + x) * 4;
    png.data[i] = Math.round(png.data[i] * (1 - a) + r * a);
    png.data[i + 1] = Math.round(png.data[i + 1] * (1 - a) + g * a);
    png.data[i + 2] = Math.round(png.data[i + 2] * (1 - a) + b * a);
    png.data[i + 3] = 255;
  };
  const fill = (x0, y0, x1, y1, hex) => {
    const c = d.hexToRgb(hex);
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(sh, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(sw, Math.round(x1)); x++) put(x, y, c);
  };
  /** 모서리가 둥근 상자 (모서리 화소는 4×4 로 나눠 덮인 만큼 섞는다) */
  const round = (x0, y0, x1, y1, r, hex) => {
    const c = d.hexToRgb(hex);
    const inside = (x, y) => {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
    };
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        let n = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) n += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
        if (n) put(x, y, c, n / 16);
      }
  };
  fill(0, 0, sw, sh, '#ffffff');
  for (const b of boxes) round(b.x * K, b.y * K, (b.x + b.w) * K, (b.y + b.h) * K, (b.radius ?? 0) * K, b.color);
  for (const t of texts) {
    if (t.desc) continue;
    const [l, tp, r, bt] = [t.x * K, t.y * K, (t.x + t.w) * K, (t.y + t.h) * K];
    const stroke = Math.max(2, Math.round((t.size ?? t.h / 1.4) * K * (t.bold ? 0.14 : 0.09)));
    let x0 = l + 4;
    if (t.icon) {
      fill(x0, tp + 4, x0 + t.icon.w * K, bt - 4, t.icon.color);
      x0 += t.icon.w * K + 12;
    }
    const rows = t.lines ? Array.from({ length: t.lines[0] }, (_, i) => [tp + i * t.lines[1] * K, tp + (i + 1) * t.lines[1] * K]) : [[tp, bt]];
    for (const [a, b] of rows) {
      const pad = t.lines ? (b - a) * 0.15 : 4;
      for (let x = x0; x + stroke < r - 4; x += stroke + 3) fill(x, a + pad, x + stroke, b - pad, t.color);
    }
  }
  const nodes = texts
    .map((t, i) => {
      const b = `[${t.x * K},${t.y * K}][${(t.x + t.w) * K},${(t.y + t.h) * K}]`;
      const size = t.size ? ` text-size-px="${t.size * K}" text-size-unit="2"` : '';
      const text = t.desc ? '' : t.text;
      const desc = t.desc ? t.text : '';
      return `<node index="${i}" class="android.widget.TextView" resource-id="" text="${text}" content-desc="${desc}" package="com.example.app" bounds="${b}"${size} clickable="false" enabled="true"/>`;
    })
    .join('');
  const inner = opt.scroll
    ? `<node class="android.widget.ScrollView" text="" package="com.example.app" scrollable="true" bounds="[0,${opt.scroll[0] * K}][${sw},${opt.scroll[1] * K}]">${nodes}</node>`
    : nodes;
  const xml = `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" package="com.example.app" bounds="[0,0][${sw},${sh}]">${inner}</node></hierarchy>`;
  return { png: PNG.sync.write(png), xml };
}

const SAME = [
  { text: '설정', x: 20, y: 56, w: 40, h: 28, size: 20, color: '#191919', bold: true },
  { text: '알림 받기', x: 20, y: 120, w: 80, h: 21, size: 15, color: '#191919' },
  { text: '마케팅 정보를 받아요', x: 20, y: 145, w: 140, h: 18, size: 13, color: '#888888' },
  { text: '9,900원', x: 280, y: 120, w: 60, h: 21, size: 15, color: '#191919', bold: true },
  { text: '저장하기', x: 140, y: 580, w: 80, h: 24, size: 16, color: '#ffffff', bold: true },
  { text: '홈', x: 170, y: 620, w: 20, h: 16, size: 11, color: '#999999' },
];
const BUTTON = [{ x: 20, y: 568, w: 320, h: 48, color: '#ff5a00', radius: 8 }];
const screen = { width: W, height: H, density: DENSITY, fontScale: 1 };

function run(texts, boxes = BUTTON, rendering = true, guide = guideOf()) {
  const { png, xml } = makeScreen(texts, boxes);
  const img = d.decodePng(png);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, img, screen, 'com.example.app');
  return { result: d.compareDesign(guide, measured, screen, rendering, img), img, measured };
}

test('화면을 잰다: dp 위치, 렌더링 정보의 sp, 배경·글자 색', () => {
  const { measured } = run(SAME);
  const t = measured.find((m) => m.text === '알림 받기');
  assert.deepEqual(t.rect, { x: 20, y: 120, w: 80, h: 21 });
  assert.deepEqual(t.fontSize, { value: 15, unit: 'sp' });
  assert.equal(t.background.hex, '#ffffff');
  assert.equal(t.color.hex, '#191919');
  const btn = measured.find((m) => m.text === '저장하기');
  assert.equal(btn.background.hex, '#ff5a00');
  assert.equal(btn.color.hex, '#ffffff');
});

test('시안과 같은 화면은 차이가 없다 (예시값 문구는 자리로 짝짓고 문구는 비교하지 않는다)', () => {
  const { result } = run(SAME);
  assert.deepEqual(result.items, [], JSON.stringify(result.items, null, 1));
  assert.equal(result.matched.position, 1, '12,000원 ↔ 9,900원');
  assert.deepEqual(result.offscreen, []);
});

test('위치를 모르는 인스턴스 안 글자는 조상 상자 자리로 화면 밖인지 본다', () => {
  const guide = guideOf();
  const tall = {
    ...guide,
    frame: { ...guide.frame, height: 2000 },
    elements: guide.elements.map((e) => (e.id === '1:11' ? { ...e, rect: { x: 0, y: 1900, w: 360, h: 40 } } : e)),
  };
  const { png, xml } = makeScreen(SAME.slice(0, 5), BUTTON);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, d.decodePng(png), screen);
  const r = d.compareDesign(tall, measured, screen, true);
  assert.deepEqual(r.offscreen, ['홈']);
  assert.equal(r.items.length, 0, JSON.stringify(r.items));
});

test('바뀐 화면: 문구·글자 크기·글자 색·간격·빠짐·더함을 심각도와 함께 낸다', () => {
  const changed = [
    { ...SAME[0], color: '#3366ff' },
    { ...SAME[1], size: 17 },
    { ...SAME[2], text: '마케팅 소식을 받아요', y: 155 },
    SAME[3],
    { text: '새 기능', x: 20, y: 300, w: 60, h: 20, size: 14, color: '#191919' },
  ];
  const { result } = run(changed);
  const by = (prop, el) => result.items.find((i) => i.prop === prop && (!el || i.element.startsWith(el)));
  assert.equal(by('color', '설정')?.severity, 'high');
  assert.equal(by('fontSize', '알림')?.severity, 'high', '2sp 차이는 높음');
  assert.equal(by('fontSize', '알림')?.actual, '17sp');
  assert.equal(by('text', '마케팅')?.actual, '마케팅 소식을 받아요');
  assert.equal(by('gap', '마케팅')?.severity, 'high', '간격 4dp → 14dp');
  assert.equal(by('missing', '저장하기')?.severity, 'high');
  assert.equal(by('extra', '새 기능')?.severity, 'medium');
  assert.equal(result.items[0].severity, 'high', '심각도 순');
  assert.ok(result.counts.high >= 4);
});

test('렌더링 정보가 없으면 글자 높이로 추정하고 차이는 낮음으로만 낸다', () => {
  const noSize = SAME.map(({ size, ...t }) => t);
  const same = run(noSize, BUTTON, false).result;
  assert.ok(same.warnings.some((w) => w.includes('추정')));
  const est = same.items.filter((i) => i.prop === 'fontSize');
  assert.ok(
    est.every((i) => i.severity === 'low' && i.accuracy === 'estimated'),
    JSON.stringify(est),
  );
  assert.equal(
    est.find((i) => i.element === '알림 받기'),
    undefined,
    '줄 높이를 아는 글자는 시안 크기가 나온다',
  );
  const big = noSize.map((t) => (t.text === '설정' ? { ...t, h: 40 } : t));
  const it = run(big, BUTTON, false).result.items.find((i) => i.prop === 'fontSize');
  assert.equal(it.severity, 'low');
  assert.equal(it.accuracy, 'estimated');
  assert.ok(Math.abs(d.estimateFontSize(42, 15, 21, 1) - 15) < 1e-9, '두 줄');
});

test('오른쪽에 붙은 요소는 오른쪽 여백끼리 비교한다 (기기 폭이 달라도)', () => {
  const wide = { ...screen, width: 412 * K };
  const shifted = SAME.map((t) => (t.text === '9,900원' ? { ...t, x: 332 } : t));
  const { png, xml } = makeScreen(shifted, BUTTON);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, d.decodePng(png), wide);
  const r = d.compareDesign(guideOf(), measured, wide, true);
  assert.equal(
    r.items.find((i) => i.element === '12,000원' && i.prop === 'inset'),
    undefined,
    '412dp 화면에서도 오른쪽 20dp',
  );
  const moved = d.compareDesign(guideOf(), measured, screen, true).items.find((i) => i.prop === 'inset' && i.element === '12,000원');
  assert.equal(moved, undefined, '360dp 로 보면 화면 밖이라 비교하지 않음');
});

test('가이드 문구를 하나도 못 찾으면 경고만 낸다', () => {
  const r = run([{ text: '전혀 다른 화면', x: 20, y: 100, w: 120, h: 20, size: 15, color: '#191919' }]).result;
  assert.ok(r.warnings.some((w) => w.includes('하나도 찾지 못했습니다')));
  assert.equal(r.items.filter((i) => i.prop === 'missing').length, 0);
});

test('가이드는 TC 의 Figma 링크로 저장하고, 결과 파일과 회차 요약을 쓴다', async () => {
  const plan = await qa.createQaPlan({ name: '디자인', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '설정 화면은 시안대로 보인다' }],
    cases: [
      {
        id: 'TC-001',
        title: '설정 화면 디자인',
        requirements: ['R-01'],
        priority: 'P1',
        kind: 'design',
        steps: ['설정 열기'],
        expected: ['시안과 같다'],
        design: { figma: FIGMA },
      },
      { id: 'TC-002', title: '일반', requirements: ['R-01'], priority: 'P1', kind: 'normal', steps: ['a'], expected: ['b'] },
    ],
  });
  await assert.rejects(d.saveDesignGuide(plan.id, 'TC-002', { metadata: METADATA }), /Figma 링크/);
  await assert.rejects(d.saveDesignGuide(plan.id, 'TC-9', { metadata: METADATA }), /TC/);
  const saved = await d.saveDesignGuide(plan.id, 'TC-001', { metadata: METADATA, code: [CODE], example: ['1:8'] });
  assert.equal(saved.guide.figma, FIGMA);
  const loaded = await d.loadDesignGuide(plan.id, 'TC-001');
  assert.equal(loaded.elements.length, saved.guide.elements.length);
  assert.equal(await d.loadDesignGuide(plan.id, 'TC-002'), undefined);

  const runRec = await qa.createQaRun(plan.id);
  const { result, img } = run([{ ...SAME[0], color: '#3366ff' }, ...SAME.slice(1)]);
  const files = await d.writeDesignReport(d.designResultDir(plan.id, 'TC-001', runRec.id), result, img, 'TC-001 설정 화면 디자인');
  for (const f of [files.diff, files.html, files.screen, join(files.dir, 'crop-1.jpg')]) assert.ok(existsSync(f), f);
  const html = readFileSync(files.html, 'utf8');
  assert.match(html, /글자 색/);
  assert.match(html, /#3366ff/);
  const sum = await d.loadDesignSummaries(plan.id, runRec.id, ['TC-001', 'TC-002']);
  assert.equal(sum.get('TC-001').counts.high, 1);
  assert.equal(sum.has('TC-002'), false);

  const rep = await qa.writeQaReport(await qa.loadQaPlan(plan.id), runRec);
  const repHtml = readFileSync(rep.html, 'utf8');
  assert.match(repHtml, /디자인 차이 1건 \(높음 1\)/);
  assert.match(repHtml, /href="design\/TC-001\/report\.html">디자인 비교</);
  assert.match(readFileSync(rep.csv, 'utf8'), /디자인 차이 1건/);
});

// ---------- 리뷰에서 찾은 것 ----------

test('디자인 코드: 3단 중괄호 속성·엔티티·= 이 든 문구·식은 글자로 치지 않음·컴포넌트 클래스', () => {
  const code = `function Btn({ text = "확인" }) { return <p className="text-[14px]" data-node-id="9:2">{text}</p>; }
export default function A() {
  return (
    <div className="bg-white" data-node-id="1:1">
      <div className="bg-[#ff0000]" style={{ maskImage: \`url('\${img}')\`, inset: { a: { b: 1 } } }} data-node-id="1:2">
        <p className="text-[#ffffff]" data-node-id="1:3">약관 &amp; 정책</p>
      </div>
      <p data-node-id="1:4">1 + 1 = 2</p>
      <Btn className="absolute bg-[#00ff00]" />
    </div>
  );
}`;
  const nodes = Object.fromEntries(d.parseFigmaCode(code).map((n) => [n.id, n]));
  assert.ok(nodes['1:2'], '3단 중괄호 속성이 있어도 태그를 읽는다');
  assert.equal(nodes['1:3'].parent, '1:2');
  assert.equal(nodes['1:3'].text, '약관 & 정책');
  assert.equal(nodes['1:4'].text, '1 + 1 = 2');
  assert.equal(nodes['1:4'].parent, '1:1', '짝 없는 닫는 태그로 부모가 깨지지 않는다');
  assert.equal(nodes['9:2'].hasText, false, '{text} 는 글자가 아니다');
  assert.ok(!nodes['1:1'].classes.includes('bg-[#00ff00]'), '컴포넌트에 준 클래스는 바깥 노드에 붙이지 않는다');
  const { guide } = d.buildDesignGuide({
    figma: FIGMA,
    metadata:
      '<frame id="1:1" name="A" x="0" y="0" width="360" height="640"><frame id="1:2" name="빨간 상자" x="0" y="0" width="100" height="40"><text id="1:3" name="Title" x="0" y="0" width="10" height="10" /></frame></frame>',
    code: [code],
  });
  const t = guide.elements.find((e) => e.id === '1:3');
  assert.equal(t.text, '약관 & 정책', '코드의 글자가 레이어 이름보다 앞선다');
  assert.equal(t.behind, '#ff0000');
});

test('디자인 코드: 너무 깊거나 많은 입력은 빨리 멈춘다', () => {
  const t0 = Date.now();
  assert.throws(() => d.parseFigmaCode('<b>'.repeat(100_000) + 'x<i>'.repeat(100_000)), /단보다 깊습니다/);
  assert.throws(() => d.parseFigmaCode(Array.from({ length: 6000 }, (_, i) => `<p data-node-id="1:${i}">a</p>`).join('')), /5000개/);
  d.parseFigmaCode('<a>' + '</c>'.repeat(200_000));
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
});

test('스크롤된 목록: 반복되는 문구가 있어도 줄이 밀리지 않고, 위로 지나간 줄은 화면 밖으로 본다', () => {
  const rows = 10;
  const meta = `<frame id="1:1" name="목록" x="0" y="0" width="360" height="1200">${Array.from({ length: rows }, (_, i) => `<text id="2:${i}" name="상품 ${i}" x="20" y="${100 + i * 100}" width="120" height="20" /><text id="3:${i}" name="장바구니" x="280" y="${100 + i * 100}" width="60" height="20" />`).join('')}</frame>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta }).guide;
  // 300dp 스크롤해 1번째 줄까지 위로 지나간 화면
  const shown = [];
  for (let i = 2; i < rows; i++) {
    const y = 100 + i * 100 - 300;
    if (y > 620) break;
    shown.push(
      { text: `상품 ${i}`, x: 20, y, w: 120, h: 20, color: '#191919' },
      { text: '장바구니', x: 280, y, w: 60, h: 20, color: '#191919' },
    );
  }
  const { png, xml } = makeScreen(shown);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, d.decodePng(png), screen);
  const r = d.compareDesign(guide, measured, screen, true);
  assert.deepEqual(r.items, [], JSON.stringify(r.items));
  assert.deepEqual(r.offscreen.sort(), ['상품 0', '상품 1', '상품 9', '장바구니', '장바구니', '장바구니'].sort());
});

test('화면 밖에 있어야 할 글자는 비슷한 문구로 다른 글자와 짝짓지 않는다', () => {
  const meta = `<frame id="1:1" name="A" x="0" y="0" width="360" height="3000"><text id="1:2" name="제목" x="20" y="40" width="40" height="20" /><text id="1:3" name="이벤트 당첨 안내" x="20" y="2500" width="120" height="20" /></frame>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta }).guide;
  const { png, xml } = makeScreen([
    { text: '제목', x: 20, y: 40, w: 40, h: 20, color: '#191919' },
    { text: '이벤트 당첨자', x: 20, y: 600, w: 120, h: 20, color: '#191919' },
  ]);
  const r = d.compareDesign(guide, d.measureTexts(parseHierarchyXml(xml).root, d.decodePng(png), screen), screen, true);
  assert.deepEqual(r.offscreen, ['이벤트 당첨 안내']);
  assert.equal(r.items.filter((i) => i.prop === 'text').length, 0);
});

test('비밀번호 칸은 재지 않고, Android 14+ 의 되돌린 sp 를 쓴다', () => {
  const xml = `<hierarchy><node class="android.widget.FrameLayout" text="" package="com.example.app" bounds="[0,0][1080,1920]"><node class="android.widget.EditText" text="secret123" password="true" package="com.example.app" bounds="[0,0][300,60]"/><node class="android.widget.TextView" text="큰 글" package="com.example.app" bounds="[0,100][300,200]" text-size-px="120" text-size-unit="2" text-size-sp="30"/></node></hierarchy>`;
  const m = d.measureTexts(parseHierarchyXml(xml).root, d.decodePng(makeScreen([]).png), { ...screen, fontScale: 1.3 });
  assert.deepEqual(
    m.map((x) => x.text),
    ['큰 글'],
  );
  assert.deepEqual(m[0].fontSize, { value: 30, unit: 'sp' });
});

// ---------- #89: 굵기·줄 높이·상자 크기·모서리, Figma 이미지, 한계 항목 ----------

/** 샘플 앱 DesignActivity 의 variant=changed 와 같은 바뀐 화면 (#77 의 6곳 + #89 의 굵기·버튼 높이·모서리) */
const CHANGED = [
  { ...SAME[0], color: '#3366ff' },
  { ...SAME[1], size: 17 },
  { ...SAME[2], text: '마케팅 소식을 받아요', y: 155 },
  { ...SAME[3], bold: false },
  { text: '새 기능', x: 280, y: 300, w: 60, h: 20, size: 14, color: '#191919' },
];
const CHANGED_BUTTON = [{ x: 20, y: 568, w: 320, h: 56, color: '#ff5a00', radius: 0 }];

test('샘플 앱 바뀐 화면: 굵기·상자 크기·모서리를 바꾼 곳이 차이로 나온다', () => {
  const { result } = run(CHANGED, CHANGED_BUTTON);
  const by = (prop, el) => result.items.find((i) => i.prop === prop && (!el || i.element.startsWith(el)));
  const w = by('weight', '12,000원');
  assert.ok(w, JSON.stringify(result.items, null, 1));
  assert.equal(w.expected, '700');
  assert.equal(w.actual, '보통 (500 이하)');
  assert.equal(w.severity, 'low', '추정값은 낮음');
  assert.equal(by('weight', '설정'), undefined, '굵게 그린 제목은 차이 없음');
  const size = by('size', '저장 버튼');
  assert.equal(size?.expected, '320×48dp');
  assert.equal(size?.actual, '320×56dp');
  assert.equal(size?.severity, 'high', '8dp 차이는 높음');
  const radius = by('radius', '저장 버튼');
  assert.equal(radius?.expected, '8dp');
  assert.ok(Math.abs(Number(radius.actual.replace('dp', ''))) <= 1, radius.actual);
  assert.equal(radius.accuracy, 'estimated');
  // #77 에서 찾던 6곳은 그대로 나온다
  for (const [prop, el] of [
    ['color', '설정'],
    ['fontSize', '알림'],
    ['text', '마케팅'],
    ['gap', '마케팅'],
    ['missing', '저장하기'],
    ['extra', '새 기능'],
  ])
    assert.ok(by(prop, el), `${prop} ${el}`);
  assert.equal(result.boxes, 1);
});

test('상자: 모서리 반경을 둥근 정도별로 어림하고, 상자가 없으면 없다고 한다', () => {
  for (const radius of [0, 4, 12, 24]) {
    const { png } = makeScreen([], [{ x: 40, y: 100, w: 200, h: 48, color: '#2255aa', radius }]);
    const box = d.measureBox(d.decodePng(png), [40 * K, 100 * K, 240 * K, 148 * K], 48);
    const want = [40 * K, 100 * K, 240 * K, 148 * K];
    assert.ok(box.bounds.every((v, i) => Math.abs(v - want[i]) <= 1), `반경 ${radius}: ${box.bounds}`);
    assert.ok(Math.abs(box.radius / K - radius) <= 1.5, `반경 ${radius} → ${box.radius / K}`);
  }
  const { png } = makeScreen([], []);
  assert.equal(d.measureBox(d.decodePng(png), [40 * K, 100 * K, 240 * K, 148 * K], 48), undefined, '상자가 없으면 없음');
  assert.equal(run(SAME).result.items.filter((i) => i.prop === 'size' || i.prop === 'radius').length, 0);
});

test('상자: 고정 폭(w-[200px]) 상자는 넓은 기기에서도 200 과 견주고, 부모를 채우는 상자는 양쪽 여백을 뺀 폭과 견준다', () => {
  const meta = `<frame id="1:1" name="A" x="0" y="0" width="360" height="640"><text id="1:2" name="제목" x="20" y="40" width="40" height="20" /><frame id="1:3" name="칩" x="80" y="100" width="200" height="40" /><frame id="1:4" name="버튼" x="20" y="200" width="320" height="48" /></frame>`;
  const code = `<div className="bg-white" data-node-id="1:1"><p data-node-id="1:2">제목</p><div className="bg-[#2255aa] w-[200px] rounded-full" data-node-id="1:3" /><div className="bg-[#ff5a00] rounded-[8px]" data-node-id="1:4" /></div>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta, code: [code] }).guide;
  assert.equal(guide.elements.find((e) => e.id === '1:3').fill, false);
  const wide = { ...screen, width: 412 * K };
  const { png, xml } = makeScreen(
    [{ text: '제목', x: 20, y: 40, w: 40, h: 20, color: '#191919' }],
    [
      { x: 106, y: 100, w: 200, h: 40, color: '#2255aa', radius: 20 },
      { x: 20, y: 200, w: 372, h: 48, color: '#ff5a00', radius: 8 },
    ],
    { width: 412 * K },
  );
  const img = d.decodePng(png);
  const r = d.compareDesign(guide, d.measureTexts(parseHierarchyXml(xml).root, img, wide), wide, true, img);
  assert.deepEqual(r.items, [], JSON.stringify(r.items, null, 1));
  assert.equal(r.boxes, 2);
});

test('줄 높이: 두 줄 글자의 줄 간격을 재고 가이드와 다르면 추정 차이로 낸다', () => {
  const meta = `<frame id="1:1" name="A" x="0" y="0" width="360" height="640"><text id="1:2" name="제목" x="20" y="40" width="40" height="20" /><text id="1:3" name="설명" x="20" y="100" width="200" height="42" /></frame>`;
  const code = `<div data-node-id="1:1"><p className="text-[15px] leading-[21px]" data-node-id="1:3">긴 설명 글</p></div>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta, code: [code] }).guide;
  const title = { text: '제목', x: 20, y: 40, w: 40, h: 20, color: '#191919' };
  const same = run([title, { text: '긴 설명 글', x: 20, y: 100, w: 200, h: 42, size: 15, color: '#191919', lines: [2, 21] }], [], true, guide);
  assert.equal(same.measured.find((m) => m.text === '긴 설명 글').lines.count, 2);
  assert.equal(same.result.items.filter((i) => i.prop === 'lineHeight').length, 0, JSON.stringify(same.result.items));
  const loose = run([title, { text: '긴 설명 글', x: 20, y: 100, w: 200, h: 52, size: 15, color: '#191919', lines: [2, 26] }], [], true, guide);
  const it = loose.result.items.find((i) => i.prop === 'lineHeight');
  assert.equal(it?.expected, '21sp');
  assert.equal(it?.actual, '26sp');
  assert.equal(it?.severity, 'low');
});

test('굵기: 견줄 보통 굵기 글자가 없으면 비교하지 않고 알린다', () => {
  const meta = `<frame id="1:1" name="A" x="0" y="0" width="360" height="640"><text id="1:2" name="제목" x="20" y="40" width="80" height="28" /></frame>`;
  const code = `<div data-node-id="1:1"><p className="text-[20px] font-bold" data-node-id="1:2">제목</p></div>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta, code: [code] }).guide;
  const r = run([{ text: '제목', x: 20, y: 40, w: 80, h: 28, size: 20, color: '#191919' }], [], true, guide).result;
  assert.equal(r.items.filter((i) => i.prop === 'weight').length, 0);
  assert.ok(r.warnings.some((w) => w.includes('굵기')));
});

/** 프레임 크기(@2x)의 가짜 Figma 이미지: 버튼 자리를 주황으로 칠한다 */
function figmaPng(scale = 2) {
  const p = new PNG({ width: 360 * scale, height: 640 * scale });
  p.data.fill(255);
  for (let y = 568 * scale; y < 616 * scale; y++)
    for (let x = 20 * scale; x < 340 * scale; x++) {
      const i = (y * p.width + x) * 4;
      p.data[i + 1] = 90;
      p.data[i + 2] = 0;
    }
  return PNG.sync.write(p);
}

function fakeFetch(calls, { status = 200, imageUrl = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc', png = figmaPng() } = {}) {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const res = (body, st = 200) => ({
      ok: st >= 200 && st < 300,
      status: st,
      headers: { get: (n) => (n === 'content-length' && Buffer.isBuffer(body) ? String(body.length) : null) },
      json: async () => body,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    });
    if (url.startsWith('https://api.figma.com/')) return res({ err: null, images: { '1:2': imageUrl } }, status);
    return res(png);
  };
}

test('Figma 이미지: 토큰이 있으면 REST 로 프레임 PNG 를 받아 가이드 옆에 두고, 보고서에 나란히 놓는다', async () => {
  const plan = await qa.createQaPlan({ name: '디자인 이미지', app: 'com.example.app' });
  await qa.saveQaPlan({
    ...plan,
    requirements: [{ id: 'R-01', text: '시안대로' }],
    cases: [
      { id: 'TC-001', title: '설정', requirements: ['R-01'], priority: 'P1', kind: 'design', steps: ['a'], expected: ['b'], design: { figma: FIGMA } },
    ],
  });
  // 토큰 없음: 받지 않고 알린다
  const none = await d.saveDesignGuide(plan.id, 'TC-001', { metadata: METADATA, code: [CODE], example: ['1:8'] });
  assert.ok(none.notes.some((n) => n.includes('FIGMA_TOKEN')));
  assert.equal(none.guide.image, undefined);

  const calls = [];
  const saved = await d.saveDesignGuide(
    plan.id,
    'TC-001',
    { metadata: METADATA, code: [CODE], example: ['1:8'] },
    { image: { token: 'figd_secret', fetch: fakeFetch(calls) } },
  );
  assert.match(calls[0].url, /^https:\/\/api\.figma\.com\/v1\/images\/AbCdEf123\?ids=1%3A2&format=png&scale=2$/);
  assert.equal(calls[0].headers['X-Figma-Token'], 'figd_secret');
  assert.equal(calls[1].headers, undefined, '이미지 주소에는 토큰을 보내지 않는다');
  assert.deepEqual(saved.guide.image, { file: 'figma.png', width: 720, height: 1280, scale: 2 });
  assert.ok(existsSync(saved.image));
  assert.ok(!readFileSync(saved.path, 'utf8').includes('figd_secret'), '토큰은 파일에 남기지 않는다');
  const guide = await d.loadDesignGuide(plan.id, 'TC-001');
  const image = await d.loadDesignImage(plan.id, 'TC-001', guide);
  assert.equal(image.width, 720);

  const { result, img } = run(CHANGED, CHANGED_BUTTON);
  const files = await d.writeDesignReport(d.designResultDir(plan.id, 'TC-001'), result, img, 'TC-001 설정', { guide, image });
  const html = readFileSync(files.html, 'utf8');
  assert.match(html, /<th>Figma<\/th><th>화면 조각<\/th>/);
  assert.ok(existsSync(join(files.dir, 'figma.jpg')));
  const idx = result.items.findIndex((i) => i.prop === 'size');
  assert.ok(existsSync(join(files.dir, `figma-${idx + 1}.jpg`)), 'Figma 조각');
  assert.match(html, new RegExp(`figma-${idx + 1}\\.jpg.+crop-${idx + 1}\\.jpg`), '같은 줄에 Figma 조각과 화면 조각');
  const extra = result.items.findIndex((i) => i.prop === 'extra');
  assert.ok(!existsSync(join(files.dir, `figma-${extra + 1}.jpg`)), '가이드에 없는 글자는 Figma 조각이 없다');

  // 다시 저장하다 받지 못하면 지난 이미지는 지운다 (다른 프레임 것일 수 있다)
  const bad = await d.saveDesignGuide(
    plan.id,
    'TC-001',
    { metadata: METADATA, code: [CODE] },
    { image: { token: 'figd_secret', fetch: fakeFetch([], { status: 403 }) } },
  );
  assert.ok(bad.notes.some((n) => n.includes('HTTP 403') && !n.includes('figd_secret')), bad.notes.join('\n'));
  assert.equal(existsSync(saved.image), false);
});

test('Figma 이미지: 알 수 없는 주소·PNG 가 아닌 응답은 받지 않는다', async () => {
  const guide = guideOf();
  await assert.rejects(
    d.fetchFigmaImage(guide, { token: 't', fetch: fakeFetch([], { imageUrl: 'http://169.254.169.254/latest' }) }),
    /알 수 없는 주소/,
  );
  await assert.rejects(d.fetchFigmaImage(guide, { token: 't', fetch: fakeFetch([], { png: Buffer.from('not png') }) }), /PNG 가 아닙니다/);
  // 머리만 아주 큰 화면이라고 적은 PNG: 풀기 전에 막는다
  const bomb = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bomb, 0);
  bomb.writeUInt32BE(13, 8);
  bomb.write('IHDR', 12, 'latin1');
  bomb.writeUInt32BE(30000, 16);
  bomb.writeUInt32BE(30000, 20);
  await assert.rejects(d.fetchFigmaImage(guide, { token: 't', fetch: fakeFetch([], { png: bomb }) }), /너무 큽니다 \(30000×30000\)/);
  await assert.rejects(d.fetchFigmaImage({ ...guide, figma: 'https://example.com/x' }, { token: 't', fetch: fakeFetch([]) }), /파일 키/);
  assert.equal(d.figmaImageScale({ width: 360, height: 640 }), 2);
  assert.equal(d.figmaImageScale({ width: 1080, height: 8000 }), 0.51);
  assert.deepEqual(d.parseFigmaLink('https://www.figma.com/design/AbC/branch/BrX/Name?node-id=12-34'), { fileKey: 'BrX', nodeId: '12:34' });
  assert.equal(d.figmaToken({ FIGMA_TOKEN: '  ' }), undefined);
});

// ---------- 한계 항목 재현 (#89) ----------

test('한계: 스크롤 경계에 반쯤 걸친 노드는 높이로 재는 값(글자 크기 추정·간격)을 쓰지 않는다', () => {
  const meta = `<frame id="1:1" name="목록" x="0" y="0" width="360" height="1000"><text id="1:2" name="제목" x="20" y="40" width="60" height="20" /><text id="1:3" name="상품 하나" x="20" y="200" width="120" height="40" /><text id="1:4" name="상품 둘" x="20" y="260" width="120" height="40" /><text id="1:5" name="상품 셋" x="20" y="320" width="120" height="40" /></frame>`;
  const code = `<div data-node-id="1:1"><p className="text-[28px] leading-[40px]" data-node-id="1:3">상품 하나</p><p className="text-[28px] leading-[40px]" data-node-id="1:4">상품 둘</p><p className="text-[28px] leading-[40px]" data-node-id="1:5">상품 셋</p></div>`;
  const guide = d.buildDesignGuide({ figma: FIGMA, metadata: meta, code: [code] }).guide;
  // 목록(100~600dp)을 스크롤해 '상품 하나'(본래 80~120)는 위가 잘려 100~120 만 보인다
  const texts = [
    { text: '제목', x: 20, y: 40, w: 60, h: 20, color: '#191919' },
    { text: '상품 하나', x: 20, y: 100, w: 120, h: 20, color: '#191919' },
    { text: '상품 둘', x: 20, y: 140, w: 120, h: 40, color: '#191919' },
    { text: '상품 셋', x: 20, y: 200, w: 120, h: 40, color: '#191919' },
  ];
  const { png, xml } = makeScreen(texts, [], { scroll: [100, 600] });
  const img = d.decodePng(png);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, img, screen);
  assert.equal(measured.find((m) => m.text === '상품 하나').clipped, true);
  assert.equal(measured.find((m) => m.text === '상품 둘').clipped, undefined);
  const r = d.compareDesign(guide, measured, screen, false, img);
  assert.equal(
    r.items.filter((i) => ['fontSize', 'gap'].includes(i.prop) && i.element.startsWith('상품')).length,
    0,
    JSON.stringify(r.items, null, 1),
  );
});

test('한계: 글자 옆 아이콘 색을 글자 색으로 잡지 않는다', () => {
  const withIcon = SAME.map((t) => (t.text === '마케팅 정보를 받아요' ? { ...t, w: 170, icon: { color: '#191919', w: 16 } } : t));
  const { result, measured } = run(withIcon);
  const m = measured.find((x) => x.text === '마케팅 정보를 받아요');
  assert.equal(m.inks.length, 2, JSON.stringify(m));
  assert.equal(result.items.filter((i) => i.prop === 'color').length, 0, JSON.stringify(result.items, null, 1));
  // 글자 색이 정말 다르면 낮음(추정)으로 낸다
  const wrong = run(withIcon.map((t) => (t.text === '마케팅 정보를 받아요' ? { ...t, color: '#3366ff' } : t))).result;
  const it = wrong.items.find((i) => i.prop === 'color');
  assert.equal(it?.severity, 'low');
  assert.match(it.note, /섞여/);
});

test('한계: RTL 화면은 좌우를 뒤집어 비교한다', () => {
  const mirrored = SAME.map((t) => ({ ...t, x: 360 - t.x - t.w }));
  const r = run(mirrored, BUTTON).result;
  assert.equal(r.rtl, true);
  assert.ok(r.warnings.some((w) => w.includes('RTL')));
  assert.deepEqual(
    r.items.filter((i) => i.prop === 'inset'),
    [],
    JSON.stringify(r.items, null, 1),
  );
  assert.equal(run(SAME).result.rtl, undefined, 'LTR 화면은 그대로');
});

test('한계: 메타데이터에 프레임이 여럿이면 링크의 프레임 안쪽만 쓴다', () => {
  const meta = `<frame id="5:1" name="다른 화면" x="0" y="0" width="360" height="640"><text id="5:2" name="다른 글" x="20" y="40" width="60" height="20" /></frame>
<frame id="1:2" name="설정 화면" x="400" y="0" width="360" height="640"><text id="1:3" name="설정" x="20" y="56" width="40" height="28" /></frame>`;
  const code = `<div data-node-id="5:1"><p className="text-[30px]" data-node-id="5:2">다른 글</p></div><div data-node-id="1:2"><p className="text-[20px]" data-node-id="1:3">설정</p></div>`;
  const { guide, notes } = d.buildDesignGuide({ figma: FIGMA, metadata: meta, code: [code] });
  assert.equal(guide.frame.id, '1:2');
  assert.deepEqual(
    guide.elements.map((e) => e.id),
    ['1:3'],
  );
  assert.deepEqual(guide.elements[0].rect, { x: 20, y: 56, w: 40, h: 28 }, '두 번째 프레임 기준');
  assert.ok(notes.some((n) => n.includes('프레임이 여럿')));
  assert.ok(notes.some((n) => n.includes('프레임 밖')));
});

test('한계: Compose 처럼 여러 글자가 한 노드로 합쳐져도 문구로 짝짓고 자리·크기는 비교하지 않는다', () => {
  const merged = [SAME[0], { text: '알림 받기, 마케팅 정보를 받아요', x: 20, y: 120, w: 140, h: 43, color: '#191919' }, ...SAME.slice(3)];
  const r = run(merged).result;
  assert.equal(r.items.filter((i) => i.prop === 'missing' || i.prop === 'extra').length, 0, JSON.stringify(r.items, null, 1));
  assert.equal(r.items.filter((i) => i.element === '알림 받기' || i.element.startsWith('마케팅')).length, 0);
  assert.ok(r.warnings.some((w) => w.includes('합쳐진')));
});

test('한계: contentDescription 만 있는 아이콘도 문구로 짝짓고, 가이드에 없는 아이콘은 더 있다고 하지 않는다', () => {
  const icons = [
    ...SAME.filter((t) => t.text !== '홈'),
    { text: '홈', x: 170, y: 618, w: 20, h: 20, desc: true },
    { text: '뒤로 가기', x: 4, y: 52, w: 12, h: 24, desc: true },
  ];
  const { result, measured } = run(icons);
  assert.equal(measured.find((m) => m.text === '홈').description, true);
  assert.deepEqual(result.items, [], JSON.stringify(result.items, null, 1));
});

test('디자인 코드: 짝이 안 맞는 긴 입력도 제곱 시간이 걸리지 않는다', () => {
  for (const unit of ['<a {', '<a b={"', "<a b='x' c={`", '<a b="']) {
    const input = unit.repeat(200_000);
    const t0 = Date.now();
    d.parseFigmaCode(input);
    assert.ok(Date.now() - t0 < 2000, `${JSON.stringify(unit)}: ${Date.now() - t0}ms`);
  }
  // 뒤에서 짝을 못 찾아도 그 앞의 태그는 읽는다
  const nodes = d.parseFigmaCode(`<p className="text-[14px]" data-node-id="1:1">가</p><a b={ ${'x'.repeat(10)}`);
  assert.equal(nodes[0].text, '가');
});
