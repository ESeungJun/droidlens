// 뷰 계층 파싱·셀렉터·화면 시그니처·위험 버튼 판정 (기기 없이 되는 순수 함수)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHierarchyXml,
  findNodes,
  center,
  toCompactText,
  structureSignature,
  screenSignature,
  isRiskyLabel,
  riskyLabelOf,
  riskyTapLabel,
  riskyTapMessage,
  clickableAt,
  similarLabels,
} from '../dist/hierarchy.js';

const node = (attrs, children = '') =>
  `<node class="${attrs.cls ?? 'android.widget.TextView'}" resource-id="${attrs.id ? `com.example:id/${attrs.id}` : ''}" text="${attrs.text ?? ''}" content-desc="${attrs.desc ?? ''}" package="com.example" bounds="${attrs.bounds ?? '[0,0][100,100]'}" clickable="${!!attrs.clickable}" long-clickable="false" scrollable="${!!attrs.scrollable}" focusable="false" focused="false" enabled="true" checkable="false" checked="false" selected="${!!attrs.selected}" password="false">${children}</node>`;
const xml = (body) => `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">${node({ cls: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, body)}</hierarchy>`;

const SCREEN = xml(
  node({ id: 'title', text: '장바구니', bounds: '[0,100][1080,200]' }) +
    node(
      { cls: 'android.widget.LinearLayout', id: 'card', bounds: '[0,300][1080,700]', clickable: true },
      node({ text: '상품 A &amp; B', bounds: '[20,320][600,380]' }) +
        node({ cls: 'android.widget.ImageButton', id: 'ic_trash', desc: '', bounds: '[900,320][1000,420]', clickable: true }),
    ) +
    node({ cls: 'android.widget.Button', id: 'btnDelete', text: '', bounds: '[0,800][500,900]', clickable: true }) +
    node({ cls: 'android.widget.Button', id: 'pay', bounds: '[0,1000][1080,1100]', clickable: true }, node({ text: '결제하기', bounds: '[400,1020][700,1080]' })) +
    node({ cls: 'android.widget.Button', id: 'display_options', text: 'Display border', bounds: '[0,1200][1080,1300]', clickable: true }),
);

test('parseHierarchyXml: 속성·bounds·엔티티·노드 수', () => {
  const h = parseHierarchyXml(SCREEN);
  assert.equal(h.nodeCount, 10);
  assert.equal(h.maxDepth, 3);
  const [t] = findNodes(h.root, { id: 'title' });
  assert.equal(t.text, '장바구니');
  assert.deepEqual(t.bounds, [0, 100, 1080, 200]);
  assert.deepEqual(center(t), { x: 540, y: 150 });
  assert.equal(findNodes(h.root, { textContains: '상품 a' })[0].text, '상품 A & B');
});

test('parseHierarchyXml: 빈 문서도 루트만 있는 트리', () => {
  const h = parseHierarchyXml('');
  assert.equal(h.nodeCount, 1);
  assert.deepEqual(findNodes(h.root, { text: 'x' }), []);
});

test('findNodes: id 는 전체·짧은 이름, className 은 끝 이름, index 는 n번째', () => {
  const { root } = parseHierarchyXml(SCREEN);
  assert.equal(findNodes(root, { id: 'com.example:id/title' }).length, 1);
  assert.equal(findNodes(root, { className: 'Button' }).length, 3);
  assert.equal(findNodes(root, { className: 'Button', index: 1 })[0].resourceId, 'com.example:id/pay');
  assert.deepEqual(findNodes(root, { className: 'Button', index: 9 }), []);
});

test('toCompactText: interactiveOnly 는 누를 수 있거나 글자가 있는 줄만', () => {
  const { root } = parseHierarchyXml(SCREEN);
  const all = toCompactText(root).split('\n');
  const some = toCompactText(root, { interactiveOnly: true }).split('\n');
  assert.ok(some.length <= all.length);
  assert.ok(some.some((l) => l.includes('"장바구니"')));
  assert.ok(toCompactText(root, { maxDepth: 1 }).split('\n').length < all.length);
});

test('시그니처: 글자가 바뀌어도 같고 구조가 바뀌면 다르다', () => {
  const a = parseHierarchyXml(SCREEN).root;
  const b = parseHierarchyXml(SCREEN.replace('장바구니', '주문서')).root;
  const c = parseHierarchyXml(SCREEN.replace('id/title', 'id/header')).root;
  assert.equal(structureSignature(a), structureSignature(b));
  assert.notEqual(structureSignature(a), structureSignature(c));
  assert.equal(screenSignature(a), screenSignature(b));
  assert.notEqual(screenSignature(a), screenSignature(c));
});

test('isRiskyLabel: 한글·영문·붙여 쓴 이름', () => {
  for (const s of ['삭제', '계정 삭제하기', '로그아웃', '결제하기', '송금', 'Delete', 'Log out', 'sign out', 'btnDelete', 'ic_trash', 'action.send', 'Place order', 'BUY']) {
    assert.equal(isRiskyLabel(s), true, s);
  }
  for (const s of ['', '다음', '확인', '완료', 'Display', 'border', 'payment_info_label'.replace('payment', 'display'), 'reorder_list', 'sender_name', 'Login']) {
    assert.equal(isRiskyLabel(s), false, s);
  }
});

test('riskyLabelOf: 글자 → 설명 → 리소스 이름, 글자가 자식에 있어도 잡는다', () => {
  const { root } = parseHierarchyXml(SCREEN);
  assert.equal(riskyLabelOf(findNodes(root, { id: 'btnDelete' })[0]), 'btnDelete');
  assert.equal(riskyLabelOf(findNodes(root, { id: 'ic_trash' })[0]), 'ic_trash');
  assert.equal(riskyLabelOf(findNodes(root, { id: 'pay' })[0]), 'pay');
  assert.equal(riskyLabelOf(findNodes(root, { id: 'display_options' })[0]), undefined);
});

test('riskyLabelOf: 카드 안의 따로 누를 수 있는 삭제 버튼 때문에 카드 전체를 막지 않는다', () => {
  const { root } = parseHierarchyXml(SCREEN);
  assert.equal(riskyLabelOf(findNodes(root, { id: 'card' })[0]), undefined);
});

test('riskyTapLabel: 좌표에서 실제로 반응할 요소를 본다', () => {
  const { root } = parseHierarchyXml(SCREEN);
  // 카드 본문 → 카드(안전), 카드 안 휴지통 → 휴지통(위험)
  assert.equal(clickableAt(root, 300, 350).resourceId, 'com.example:id/card');
  assert.equal(riskyTapLabel(root, 300, 350), undefined);
  assert.equal(riskyTapLabel(root, 950, 370), 'ic_trash');
  // 라벨 글자를 셀렉터로 골랐을 때 그 부모 버튼
  const label = findNodes(root, { text: '결제하기' })[0];
  assert.equal(riskyTapLabel(root, 550, 1050, label), '결제하기');
  // 아무것도 없는 자리
  assert.equal(riskyTapLabel(root, 500, 2300), undefined);
  assert.match(riskyTapMessage('삭제', '호출'), /"삭제".*allowDanger: true 로 다시 호출하세요/);
});

test('similarLabels: 포함 관계 먼저, 비슷한 것이 없으면 빈 배열', () => {
  const { root } = parseHierarchyXml(SCREEN);
  assert.deepEqual(similarLabels(root, { text: '장바구니 담기' }), ['장바구니']);
  assert.equal(similarLabels(root, { text: '결제' })[0], '결제하기');
  assert.deepEqual(similarLabels(root, { text: 'zzzzqqq' }), []);
  assert.deepEqual(similarLabels(root, { className: 'Button' }), []);
  assert.ok(similarLabels(root, { id: 'btn_delete' }).includes('btnDelete'));
});
