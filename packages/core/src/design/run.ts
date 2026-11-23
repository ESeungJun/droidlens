import type { DeviceAdb } from '../adb.js';
import { getDeviceInfo, screenshot } from '../device.js';
import { dumpHierarchyWithRendering } from '../hierarchy.js';
import { compareDesign, type DesignCompareResult } from './compare.js';
import { decodePng, measureTexts, type ScreenMetrics } from './measure.js';
import { writeDesignReport, type DesignReportFiles } from './report.js';
import { designResultDir, loadDesignCase, loadDesignGuide } from './store.js';

/**
 * 시스템 글자 크기 배율. 화면 설정(mGlobalConfiguration 의 첫 값)을 먼저 본다:
 * 제조사 설정 화면은 settings 의 font_scale 을 쓰지 않기도 한다 (LG G8: settings 는 null, 실제 1.1). 못 읽으면 1
 */
export async function fontScaleOf(dev: DeviceAdb): Promise<number> {
  const ok = (v: number) => Number.isFinite(v) && v > 0 && v < 10;
  const conf = await dev.shell('dumpsys window | grep -m1 mGlobalConfiguration').catch(() => '');
  const c = Number.parseFloat(/mGlobalConfiguration=\{(\d+(?:\.\d+)?) /.exec(conf)?.[1] ?? '');
  if (ok(c)) return c;
  const v = Number.parseFloat((await dev.shell('settings get system font_scale').catch(() => '')).trim());
  return ok(v) ? v : 1;
}

/** 지금 기기 화면을 TC 의 디자인 가이드와 비교하고 결과를 회차(없으면 TC 의 last) 폴더에 쓴다 */
export async function compareDesignOnDevice(
  dev: DeviceAdb,
  planId: string,
  caseId: string,
  runId?: string,
): Promise<{ result: DesignCompareResult; files: DesignReportFiles }> {
  const { plan, case: c } = await loadDesignCase(planId, caseId);
  const guide = await loadDesignGuide(planId, caseId);
  if (!guide) throw new Error(`${caseId} 의 디자인 가이드가 없습니다. Figma 에서 읽어 design_guide_save 로 먼저 저장하세요`);
  if (guide.figma !== c.design?.figma)
    throw new Error(`${caseId} 의 Figma 링크가 가이드를 저장한 뒤 바뀌었습니다. design_guide_save 로 다시 저장하세요`);
  const { hierarchy, rendering } = await dumpHierarchyWithRendering(dev);
  const [png, info, fontScale] = await Promise.all([screenshot(dev), getDeviceInfo(dev), fontScaleOf(dev)]);
  const img = decodePng(png);
  // 화면 크기는 스크린샷 기준 (wm size 는 회전·해상도 바꾸기를 반영하지 않을 수 있다)
  const screen: ScreenMetrics = { width: img.width, height: img.height, density: info.screen.density || 160, fontScale };
  const texts = measureTexts(hierarchy.root, img, screen, plan.app);
  const result = compareDesign(guide, texts, screen, rendering);
  const files = await writeDesignReport(designResultDir(planId, caseId, runId), result, img, `${c.id} ${c.title}`);
  return { result, files };
}
