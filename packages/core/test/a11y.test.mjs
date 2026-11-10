// 접근성 점검 (뷰 계층만으로 보는 규칙)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditA11y } from '../dist/a11y.js';

let seq = 0;
const n = (o = {}) => ({
  id: `0.${seq++}`, depth: 1, className: 'android.widget.Button', resourceId: '', text: '', contentDesc: '', packageName: 'p',
  bounds: [100, 100, 400, 300], clickable: true, longClickable: false, scrollable: false, focusable: true, focused: false, enabled: true,
  checkable: false, checked: false, selected: false, password: false, children: [], ...o,
});
const root = (...children) => ({ ...n({ depth: 0, clickable: false, bounds: [0, 0, 1080, 2400] }), children });
const kinds = (issues) => issues.map((i) => i.kind).sort();
const OPTS = { density: 480, screen: { width: 1080, height: 2400 } }; // 1dp = 3px, 48dp = 144px

test('터치 영역: 48dp 미만이면 잡고, 딱 48dp 는 통과', () => {
  const small = auditA11y(root(n({ text: '확인', bounds: [100, 100, 200, 244] })), OPTS);
  assert.deepEqual(kinds(small), ['small-target']);
  assert.match(small[0].detail, /33x48dp/);
  assert.deepEqual(auditA11y(root(n({ text: '확인', bounds: [100, 100, 244, 244] })), OPTS), []);
});

test('터치 영역: 화면 가장자리에서 잘린 요소와 누를 수 없는 요소는 재지 않는다', () => {
  assert.deepEqual(auditA11y(root(n({ text: '끝 항목', bounds: [0, 2380, 1080, 2400] })), OPTS), []);
  assert.deepEqual(auditA11y(root(n({ text: '라벨', clickable: false, bounds: [100, 100, 120, 120] })), OPTS), []);
  assert.deepEqual(auditA11y(root(n({ text: '꺼진 버튼', enabled: false, bounds: [100, 100, 120, 120] })), OPTS), []);
});

test('라벨 없음: 글자·설명이 자식에도 없을 때만', () => {
  assert.deepEqual(kinds(auditA11y(root(n({ className: 'android.widget.ImageButton' })), OPTS)), ['no-label']);
  assert.deepEqual(auditA11y(root(n({ children: [n({ depth: 2, clickable: false, text: '상품' })] })), OPTS), []);
  assert.deepEqual(auditA11y(root(n({ contentDesc: '닫기' })), OPTS), []);
});

test('같은 설명 반복: 글자 없이 설명만 같은 버튼이 둘 이상', () => {
  const r = auditA11y(root(n({ contentDesc: '더보기' }), n({ contentDesc: '더보기', bounds: [100, 400, 400, 600] }), n({ contentDesc: '닫기', bounds: [100, 700, 400, 900] })), OPTS);
  assert.deepEqual(kinds(r), ['duplicate-label']);
  assert.match(r[0].detail, /"더보기" 이 2개/);
});

test('크기 0·화면 밖', () => {
  const r = auditA11y(root(n({ text: 'a', bounds: [100, 100, 100, 300] }), n({ text: 'b', bounds: [1200, 100, 1500, 300] })), OPTS);
  assert.deepEqual(kinds(r), ['offscreen', 'offscreen']);
});

test('밀도를 모르면 160dpi 로 본다 (px = dp)', () => {
  assert.deepEqual(kinds(auditA11y(root(n({ text: 'x', bounds: [100, 100, 140, 140] })), { density: 0 })), ['small-target']);
});
