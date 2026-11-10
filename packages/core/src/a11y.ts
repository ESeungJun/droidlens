import { flatten, type ViewNode } from './hierarchy.js';

/**
 * 접근성 점검 (순수 함수). 뷰 계층만으로 볼 수 있는 것만 본다: 터치 영역 크기, 라벨 유무, 같은 라벨 반복, 화면 밖·크기 0.
 * 색 대비는 스크린샷 픽셀이 필요해 다루지 않는다
 */

export type A11yIssueKind = 'small-target' | 'no-label' | 'duplicate-label' | 'offscreen';

export interface A11yIssue {
  kind: A11yIssueKind;
  node: ViewNode;
  /** 사람이 읽는 설명 (예: "32x32dp, 최소 48x48dp") */
  detail: string;
}

/** Android 접근성 지침의 최소 터치 영역 */
export const MIN_TOUCH_DP = 48;

// 체크만 되는 요소(행 안의 라디오·체크박스 표시)는 행 전체가 터치 대상이라 보지 않는다
const actionable = (n: ViewNode) => n.depth > 0 && n.enabled && (n.clickable || n.longClickable);

/** 요소나 그 안의 글자·설명. 스크린리더가 읽을 것이 있는지 본다 */
function hasLabel(n: ViewNode): boolean {
  return !!(n.text.trim() || n.contentDesc.trim()) || n.children.some(hasLabel);
}

/**
 * @param density 화면 밀도(dpi). px → dp 환산에 쓴다
 * @param screen 화면 크기(px). 없으면 루트 bounds
 */
export function auditA11y(root: ViewNode, opts: { density: number; screen?: { width: number; height: number } }): A11yIssue[] {
  const scale = (opts.density || 160) / 160;
  const sw = opts.screen?.width || root.bounds[2];
  const sh = opts.screen?.height || root.bounds[3];
  const issues: A11yIssue[] = [];
  const byDesc = new Map<string, ViewNode[]>();
  for (const n of flatten(root)) {
    if (!actionable(n)) continue;
    const [l, t, r, b] = n.bounds;
    const w = r - l;
    const h = b - t;
    if (w <= 0 || h <= 0 || r <= 0 || b <= 0 || l >= sw || t >= sh) {
      issues.push({ kind: 'offscreen', node: n, detail: w <= 0 || h <= 0 ? '크기가 0 이다' : '화면 밖에 있다' });
      continue;
    }
    const wd = Math.round(w / scale);
    const hd = Math.round(h / scale);
    // 화면 가장자리에서 잘린 요소(스크롤 중인 목록의 끝 항목)는 실제 크기를 알 수 없어 재지 않는다
    const clipped = l <= 0 || t <= 0 || r >= sw || b >= sh;
    if (!clipped && (wd < MIN_TOUCH_DP || hd < MIN_TOUCH_DP)) {
      issues.push({ kind: 'small-target', node: n, detail: `${wd}x${hd}dp (최소 ${MIN_TOUCH_DP}x${MIN_TOUCH_DP}dp)` });
    }
    if (!hasLabel(n)) issues.push({ kind: 'no-label', node: n, detail: '글자도 설명(contentDescription)도 없다' });
    else if (!n.text.trim() && n.contentDesc.trim()) byDesc.set(n.contentDesc.trim(), [...(byDesc.get(n.contentDesc.trim()) ?? []), n]);
  }
  // 글자 없이 설명만 있는 버튼 여럿이 같은 설명이면 스크린리더로는 구분되지 않는다
  for (const [desc, nodes] of byDesc) {
    if (nodes.length > 1) issues.push({ kind: 'duplicate-label', node: nodes[0], detail: `설명 "${desc}" 이 ${nodes.length}개 요소에 똑같이 붙어 있다` });
  }
  return issues;
}
