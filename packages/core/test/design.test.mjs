// 디자인 비교 (#77): Figma 커넥터 응답 파싱, 화면 재기(글자 크기·색), 짝짓기, 차이 판정, 결과 파일을 시험한다.
// 픽스처는 커넥터 응답 형식만 흉내 낸 합성 화면이다 (실제 시안은 넣지 않는다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const home = mkdtempSync(join(import.meta.dirname, '.test-home-'));
process.env.DROIDLENS_HOME = home;
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

/** texts: [{ text, x, y, w, h (dp), size (sp), color, bg? }] / boxes: [{ x, y, w, h, color }] */
function makeScreen(texts, boxes = []) {
  const png = new PNG({ width: W, height: H });
  const fill = (x0, y0, x1, y1, hex) => {
    const [r, g, b] = d.hexToRgb(hex);
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const i = (y * W + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
  };
  fill(0, 0, W, H, '#ffffff');
  for (const b of boxes) fill(b.x * K, b.y * K, (b.x + b.w) * K, (b.y + b.h) * K, b.color);
  // 글자 획 흉내: 가장자리 4px 는 배경으로 두고 안쪽에 세로 막대
  for (const t of texts) {
    const [l, tp, r, bt] = [t.x * K, t.y * K, (t.x + t.w) * K, (t.y + t.h) * K];
    for (let x = l + 4; x < r - 4; x += 6) fill(x, tp + 4, x + 3, bt - 4, t.color);
  }
  const nodes = texts
    .map((t, i) => {
      const b = `[${t.x * K},${t.y * K}][${(t.x + t.w) * K},${(t.y + t.h) * K}]`;
      const size = t.size ? ` text-size-px="${t.size * K}" text-size-unit="2"` : '';
      return `<node index="${i}" class="android.widget.TextView" resource-id="" text="${t.text}" content-desc="" package="com.example.app" bounds="${b}"${size} clickable="false" enabled="true"/>`;
    })
    .join('');
  const xml = `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" package="com.example.app" bounds="[0,0][${W},${H}]">${nodes}</node></hierarchy>`;
  return { png: PNG.sync.write(png), xml };
}

const SAME = [
  { text: '설정', x: 20, y: 56, w: 40, h: 28, size: 20, color: '#191919' },
  { text: '알림 받기', x: 20, y: 120, w: 80, h: 21, size: 15, color: '#191919' },
  { text: '마케팅 정보를 받아요', x: 20, y: 145, w: 140, h: 18, size: 13, color: '#888888' },
  { text: '9,900원', x: 280, y: 120, w: 60, h: 21, size: 15, color: '#191919' },
  { text: '저장하기', x: 140, y: 580, w: 80, h: 24, size: 16, color: '#ffffff' },
  { text: '홈', x: 170, y: 620, w: 20, h: 16, size: 11, color: '#999999' },
];
const BUTTON = [{ x: 20, y: 568, w: 320, h: 48, color: '#ff5a00' }];
const screen = { width: W, height: H, density: DENSITY, fontScale: 1 };

function run(texts, boxes = BUTTON, rendering = true) {
  const { png, xml } = makeScreen(texts, boxes);
  const img = d.decodePng(png);
  const measured = d.measureTexts(parseHierarchyXml(xml).root, img, screen, 'com.example.app');
  return { result: d.compareDesign(guideOf(), measured, screen, rendering), img, measured };
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
