import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bounds } from '../hierarchy.js';
import { writeFileAtomic, writeJson } from '../workspace.js';
import { DESIGN_REPORT_TOKENS } from '../report-tokens.js';
import { DIFF_PROP_LABEL, SEVERITY_LABEL, type DesignCompareResult, type Severity } from './compare.js';
import type { DesignGuide, GuideElement } from './guide.js';
import type { Raster } from './measure.js';
import { rasterToJpeg } from '../image.js';
import { htmlEscape as esc } from '../qa/report.js';

/**
 * 디자인 비교 결과 (#77, #89):
 *   diff.json    차이 목록 (에이전트·데스크톱 앱이 읽음)
 *   screen.jpg   차이 자리에 심각도 색 상자를 그린 화면
 *   crop-N.jpg   항목별로 잘라 낸 화면
 *   figma.jpg    가이드의 Figma 프레임 이미지 (가이드에 이미지가 있을 때)
 *   figma-N.jpg  항목의 가이드 요소 자리를 Figma 이미지에서 잘라 낸 것 (화면 조각과 나란히)
 *   report.html  사람이 보는 표
 */

const SEV_RGB: Record<Severity, [number, number, number]> = { high: [220, 38, 38], medium: [234, 140, 0], low: [37, 99, 235] };
const MAX_CROPS = 40;

function copy(img: Raster): Raster {
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

function strokeRect(img: Raster, [l, t, r, b]: Bounds, rgb: [number, number, number], w: number): void {
  const x0 = Math.max(0, Math.floor(l));
  const y0 = Math.max(0, Math.floor(t));
  const x1 = Math.min(img.width, Math.ceil(r));
  const y1 = Math.min(img.height, Math.ceil(b));
  if (x0 >= x1 || y0 >= y1) return;
  const set = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  };
  for (let k = 0; k < w; k++) {
    for (let x = x0; x < x1; x++) {
      if (y0 - k - 1 >= 0) set(x, y0 - k - 1);
      if (y1 + k < img.height) set(x, y1 + k);
    }
    for (let y = Math.max(0, y0 - w); y < Math.min(img.height, y1 + w); y++) {
      if (x0 - k - 1 >= 0) set(x0 - k - 1, y);
      if (x1 + k < img.width) set(x1 + k, y);
    }
  }
}

function crop(img: Raster, [l, t, r, b]: Bounds): Raster {
  const x0 = Math.min(img.width - 1, Math.max(0, Math.floor(l)));
  const y0 = Math.min(img.height - 1, Math.max(0, Math.floor(t)));
  const w = Math.max(1, Math.min(img.width, Math.ceil(r)) - x0);
  const h = Math.max(1, Math.min(img.height, Math.ceil(b)) - y0);
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  return { width: w, height: h, data };
}

const toJpeg = (img: Raster, maxEdge: number) => rasterToJpeg(img, maxEdge, 75).data;

export function designReportHtml(
  r: DesignCompareResult,
  title: string,
  crops: Map<number, string>,
  figmaCrops: Map<number, string> = new Map(),
  figma = false,
): string {
  const pills = (['high', 'medium', 'low'] as const)
    .map((k) => `<span class="pill ${k}">${SEVERITY_LABEL[k]} ${r.counts[k]}</span>`)
    .join(' ');
  const rows = r.items
    .map((it, i) => {
      const img = crops.get(i);
      const fig = figmaCrops.get(i);
      const pic = (src: string | undefined, alt: string) =>
        src ? `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${alt}"></a>` : '';
      const val = (v?: string) => (v ? esc(v) : '');
      const swatch = (v?: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? `<i class="sw" style="background:${v}"></i>` : '');
      const delta = it.delta === undefined ? '' : `${it.delta}${it.unit ?? ''}`;
      return `<tr><td class="id">${i + 1}</td><td><span class="pill ${it.severity}">${SEVERITY_LABEL[it.severity]}</span></td><td>${esc(DIFF_PROP_LABEL[it.prop])}${it.accuracy === 'estimated' ? ' <span class="pill">추정</span>' : ''}</td><td>${esc(it.element)}</td><td>${swatch(it.expected)}${val(it.expected)}</td><td>${swatch(it.actual)}${val(it.actual)}</td><td>${esc(delta)}</td><td>${val(it.note)}</td>${figma ? `<td>${pic(fig, 'Figma')}</td>` : ''}<td>${pic(img, '화면')}</td></tr>`;
    })
    .join('');
  const warn = r.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  const off = r.offscreen.length
    ? `<p class="sub">화면 밖이라 비교하지 않은 글자 ${r.offscreen.length}개: ${esc(r.offscreen.slice(0, 20).join(', '))}</p>`
    : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 디자인 비교</title>
<style>${DESIGN_REPORT_TOKENS}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo",sans-serif;padding:24px 16px}
main{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}
@media (max-width:900px){main{grid-template-columns:1fr}}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 12px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
.id{font-family:ui-monospace,Menlo,monospace;font-size:12px}td img{max-width:160px;max-height:80px;border:1px solid var(--line);border-radius:4px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;white-space:nowrap;background:var(--mbg);color:var(--mute)}
.pill.high{background:var(--high-bg);color:var(--high)}.pill.medium{background:var(--medium-bg);color:var(--medium)}.pill.low{background:var(--low-bg);color:var(--low)}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line);margin-right:6px;vertical-align:-1px}
aside img{width:100%;border:1px solid var(--line);border-radius:10px}
aside .pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}aside figure{margin:0}aside figcaption{font-size:12px;color:var(--mute);margin-bottom:4px}
</style></head><body><main><section>
<h1>${esc(title)} — 디자인 비교</h1>
<p class="sub">Figma 프레임 ${esc(r.frame.name || r.frame.id)} (${r.frame.width}×${r.frame.height}, 배율 ${r.scale}) · 화면 ${r.screen.width}×${r.screen.height}dp · 글자 크기 배율 ${r.screen.fontScale}</p>
<p>${pills} <span class="sub">가이드 글자 ${r.guideTexts}개 중 ${r.matched.exact + r.matched.normalized + r.matched.similar + r.matched.position}개를 화면에서 찾음</span></p>
${warn ? `<ul class="sub">${warn}</ul>` : ''}${off}
<div class="wrap"><table><thead><tr><th>#</th><th>심각도</th><th>항목</th><th>요소</th><th>가이드</th><th>화면</th><th>차이</th><th>메모</th>${figma ? '<th>Figma</th>' : ''}<th>화면 조각</th></tr></thead><tbody>${rows || `<tr><td colspan="${figma ? 10 : 9}">허용치를 넘는 차이가 없습니다</td></tr>`}</tbody></table></div>
</section><aside>${
    figma
      ? `<div class="pair"><figure><figcaption>Figma</figcaption><a href="figma.jpg" target="_blank" rel="noopener"><img src="figma.jpg" alt="Figma 프레임"></a></figure><figure><figcaption>화면</figcaption><a href="screen.jpg" target="_blank" rel="noopener"><img src="screen.jpg" alt="차이 자리에 상자를 그린 화면"></a></figure></div>`
      : '<img src="screen.jpg" alt="차이 자리에 상자를 그린 화면">'
  }${figma ? '' : '<p class="sub">Figma 이미지가 없습니다. FIGMA_TOKEN 을 설정하고 가이드를 다시 저장하면 나란히 놓습니다</p>'}</aside></main></body></html>`;
}

export interface DesignReportFiles {
  dir: string;
  diff: string;
  html: string;
  screen: string;
}

/** 가이드 요소가 Figma 이미지에서 차지하는 자리 (이미지 px). 위치를 모르면(인스턴스 안) 위치를 아는 가장 가까운 조상의 자리 */
function figmaArea(guide: DesignGuide, id: string): Bounds | undefined {
  const byId = new Map<string, GuideElement>(guide.elements.map((e) => [e.id, e]));
  const k = guide.image?.scale ?? 1;
  const seen = new Set<string>();
  for (let p = byId.get(id); p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
    seen.add(p.id);
    if (p.rect) return [p.rect.x * k, p.rect.y * k, (p.rect.x + p.rect.w) * k, (p.rect.y + p.rect.h) * k];
  }
  return undefined;
}

export interface DesignReportFigma {
  guide: DesignGuide;
  /** guide.image 의 PNG 를 푼 것 */
  image: Raster;
}

/** 결과 폴더에 diff.json·screen.jpg·crop-N.jpg·report.html (Figma 이미지가 있으면 figma.jpg·figma-N.jpg) 을 쓴다 */
export async function writeDesignReport(
  dir: string,
  r: DesignCompareResult,
  img: Raster,
  title: string,
  figma?: DesignReportFigma,
): Promise<DesignReportFiles> {
  await mkdir(dir, { recursive: true });
  const marked = copy(img);
  const line = Math.max(2, Math.round(img.width / 360));
  const crops = new Map<number, string>();
  const figmaCrops = new Map<number, string>();
  // 한 요소에 차이가 여럿이면 가장 높은 심각도 색이 남게 낮은 것부터 그린다
  for (const it of [...r.items].reverse()) if (it.bounds) strokeRect(marked, it.bounds, SEV_RGB[it.severity], line);
  // Figma 조각의 여백: 화면 조각과 같은 dp 만큼 (화면 12dp ≒ Figma 12px ÷ 배율)
  const figPad = figma ? Math.round((12 / (r.scale || 1)) * (figma.guide.image?.scale ?? 1)) : 0;
  for (const [i, it] of r.items.entries()) {
    if (crops.size >= MAX_CROPS) break;
    if (it.bounds) {
      const pad = 12 * line;
      const name = `crop-${i + 1}.jpg`;
      const [l, t, rr, b] = it.bounds;
      await writeFileAtomic(join(dir, name), toJpeg(crop(img, [l - pad, t - pad, rr + pad, b + pad]), 480));
      crops.set(i, name);
    }
    const area = figma && it.guideId ? figmaArea(figma.guide, it.guideId) : undefined;
    if (figma && area) {
      const name = `figma-${i + 1}.jpg`;
      const [l, t, rr, b] = area;
      await writeFileAtomic(join(dir, name), toJpeg(crop(figma.image, [l - figPad, t - figPad, rr + figPad, b + figPad]), 480));
      figmaCrops.set(i, name);
    }
  }
  const files = { dir, diff: join(dir, 'diff.json'), html: join(dir, 'report.html'), screen: join(dir, 'screen.jpg') };
  await writeFileAtomic(files.screen, toJpeg(marked, 1200));
  if (figma) await writeFileAtomic(join(dir, 'figma.jpg'), toJpeg(figma.image, 1200));
  await writeJson(files.diff, r);
  await writeFileAtomic(files.html, designReportHtml(r, title, crops, figmaCrops, !!figma));
  return files;
}
