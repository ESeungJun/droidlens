import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, hasSelector, resolveNode, recordStep, logAction, nodeLabel, recorder, cleanSelector, text, serialArg, selectorShape, pickSelector, describeNode, readOnly, acts, refuseRisky, allowDangerArg } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 조작 ----------

  server.registerTool(
    'tap',
    {
      description: '셀렉터로 찾은 요소의 중앙을 탭하거나, x/y 좌표를 탭. 셀렉터 사용을 권장. 삭제·결제·로그아웃·전송 같은 위험 버튼은 allowDanger 없이는 누르지 않는다',
      inputSchema: {
        ...serialArg,
        ...selectorShape,
        x: z.number().optional(),
        y: z.number().optional(),
        long: z.boolean().optional().describe('길게 누르기'),
        ...allowDangerArg,
      },
      annotations: acts,
    },
    async (a) => {
      const dev = await device(a.serial);
      let x = a.x;
      let y = a.y;
      let what = `${x},${y}`;
      const sel = pickSelector(a);
      let node: dl.ViewNode | undefined;
      let tree: dl.ViewNode | undefined;
      if (hasSelector(sel)) {
        tree = (await dl.dumpHierarchy(dev)).root;
        node = await resolveNode(dev, sel, tree);
        ({ x, y } = dl.center(node));
        what = describeNode(node);
      }
      if (x === undefined || y === undefined) throw new Error('셀렉터나 x/y 중 하나가 필요합니다');
      if (!a.allowDanger) await refuseRisky(dev, x, y, node, tree);
      if (a.long) await dl.longPress(dev, x, y);
      else await dl.tap(dev, x, y);
      // 녹화: 셀렉터로 눌렀으면 셀렉터를, 아니면 좌표를 남긴다 (셀렉터 쪽이 해상도·레이아웃 변화에 강하다)
      const target = hasSelector(sel) ? cleanSelector(sel) : undefined;
      recordStep(
        target
          ? ((a.long ? { longPress: target } : { tap: target }) as dl.ScriptStep)
          : { tapAt: { x: Math.round(x), y: Math.round(y) } },
        `${a.long ? '길게 누름' : '탭'} ${node ? nodeLabel(node) : `좌표 (${Math.round(x)}, ${Math.round(y)})`}${a.allowDanger ? ' · 위험 버튼 허용' : ''}`,
      );
      return text(`${a.long ? 'long-pressed' : 'tapped'}: ${what}`);
    },
  );

  server.registerTool(
    'swipe',
    {
      description: '스와이프. direction(up/down/left/right)으로 화면 스크롤 또는 좌표 직접 지정',
      inputSchema: {
        ...serialArg,
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('손가락 이동 방향. up = 내용이 아래로 스크롤'),
        x1: z.number().optional(),
        y1: z.number().optional(),
        x2: z.number().optional(),
        y2: z.number().optional(),
        durationMs: z.number().int().optional(),
      },
      annotations: acts,
    },
    async (a) => {
      const dev = await device(a.serial);
      if (a.direction) {
        await dl.swipeDirection(dev, a.direction, a.durationMs);
        recordStep({ swipe: a.direction }, `스와이프 ${({ up: '위로', down: '아래로', left: '왼쪽으로', right: '오른쪽으로' } as Record<string, string>)[a.direction] ?? a.direction}`);
        return text(`swiped ${a.direction}`);
      }
      if ([a.x1, a.y1, a.x2, a.y2].some((v) => v === undefined)) throw new Error('direction 또는 x1,y1,x2,y2가 필요합니다');
      await dl.swipe(dev, a.x1!, a.y1!, a.x2!, a.y2!, a.durationMs);
      logAction(`스와이프 (${a.x1}, ${a.y1}) → (${a.x2}, ${a.y2})`);
      return text('swiped');
    },
  );

  server.registerTool(
    'type_text',
    {
      description: '현재 포커스된 입력창에 텍스트 입력 (온디바이스 에이전트가 있으면 한글 등 유니코드 지원). selector를 주면 먼저 탭해 포커스',
      inputSchema: {
        ...serialArg,
        ...selectorShape,
        value: z.string().describe('넣을 글자'),
        clear: z.boolean().optional().describe('입력 전 기존 텍스트 삭제'),
        ...allowDangerArg,
      },
      annotations: acts,
    },
    async (a) => {
      const dev = await device(a.serial);
      const sel = pickSelector(a);
      let into: dl.ViewNode | undefined;
      if (hasSelector(sel)) {
        const tree = (await dl.dumpHierarchy(dev)).root;
        into = await resolveNode(dev, sel, tree);
        const { x, y } = dl.center(into);
        // 포커스를 주려는 탭도 기기를 누르는 것이라 tap 과 같은 검사를 거친다
        if (!a.allowDanger) await refuseRisky(dev, x, y, into, tree);
        await dl.tap(dev, x, y);
        await dl.sleep(300);
      }
      // 셀렉터로 칸을 탭한 뒤 입력이 실패해도 화면은 바뀌었으므로 그 탭을 조작 로그에 남긴다
      try {
        // 조작 로그에서 값을 보여도 되는지 판단하려면 실제로 글자를 받는 칸을 알아야 한다. 셀렉터가 입력칸을 감싼
        // 레이아웃을 가리킬 수도 있어 입력칸이 아니면 포커스된 칸을 찾는다 (시나리오 기록 중일 때만)
        const field = into && isTextField(into) ? into : recorder.active ? await focusedField(dev) : undefined;
        let cleared = 0;
        if (a.clear) {
          const agent = await dl.ensureAgent(dev);
          if (agent) {
            await dl.replaceText(dev, a.value);
            recordStep({ type: { text: a.value, clear: true, ...(hasSelector(sel) ? { into: cleanSelector(sel) } : {}) } } as dl.ScriptStep, typedLabel(a.value, field, into, true));
            return text(`replaced with ${a.value.length} chars`);
          }
          // 에이전트가 없으면 커서를 끝으로 보내고 DEL 을 반복한다. 칸의 글자 수를 알면 그만큼, 모르면 60번
          const known = field && isTextField(field) && !field.password ? field.text.length : undefined;
          cleared = Math.min(Math.max(known ?? 60, 1) + (known === undefined ? 0 : 2), 400);
          await dl.pressKey(dev, 123); // MOVE_END
          await dev.shell(`input keyevent ${Array(cleared).fill(67).join(' ')}`);
        }
        await dl.typeText(dev, a.value);
        recordStep({ type: { text: a.value, ...(hasSelector(sel) ? { into: cleanSelector(sel) } : {}) } } as dl.ScriptStep, typedLabel(a.value, field, into, !!a.clear));
        return text(`typed ${a.value.length} chars${cleared ? ` (에이전트 없이 지워서 기존 글자는 뒤에서 ${cleared}자까지만 지웠습니다)` : ''}`);
      } catch (e) {
        if (into && hasSelector(sel)) logAction(`탭 ${nodeLabel(into)} — 입력 실패: ${(e as Error).message.split('\n')[0]}`);
        throw e;
      }
    },
  );

  server.registerTool(
    'press_key',
    {
      description: '하드웨어/시스템 키 입력',
      inputSchema: { ...serialArg, key: z.enum(Object.keys(dl.KEYCODES) as [keyof typeof dl.KEYCODES]) },
      annotations: acts,
    },
    async ({ serial, key }) => {
      await dl.pressKey(await device(serial), key);
      recordStep({ key }, `키 ${key}`);
      return text(`pressed ${key}`);
    },
  );

  server.registerTool(
    'wait_for',
    {
      description:
        '셀렉터에 맞는 요소가 나타날(또는 gone=true면 사라질) 때까지 대기. 화면을 바꾸는 조작(tap·launch_app 등) 뒤에 다음 화면을 기다릴 때 쓴다. ' +
        '시간 안에 못 찾으면 지금 화면의 Activity 와 비슷한 글자 후보를 알려 준다',
      inputSchema: {
        ...serialArg,
        ...selectorShape,
        timeoutMs: z.number().int().min(0).max(120_000).optional().describe('기다릴 시간(ms). 기본 10000'),
        gone: z.boolean().optional().describe('true 면 요소가 사라질 때까지 기다린다'),
      },
      annotations: readOnly,
    },
    async (a) => {
      const dev = await device(a.serial);
      const sel = pickSelector(a);
      if (!hasSelector(sel)) throw new Error('셀렉터(id·text·textContains·desc·descContains·className 중 하나)가 필요합니다');
      const timeout = a.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeout;
      let last: dl.Hierarchy | undefined;
      let lastError: string | undefined;
      // 시간이 0 이어도 한 번은 본다
      do {
        // 에이전트가 없으면 uiautomator 로 덤프한다 (1.5~3초). 화면 전환 중의 일시 오류는 다음 바퀴에서 다시 본다
        const h = await dl.dumpHierarchy(dev).catch((e: Error) => {
          lastError = e.message.split('\n')[0];
          return undefined;
        });
        if (h) {
          last = h;
          const found = dl.findNodes(h.root, sel);
          if (a.gone ? found.length === 0 : found.length > 0) {
            recordStep(
              { wait: { ...cleanSelector(sel), ...(a.gone ? { gone: true } : {}), ...(a.timeoutMs ? { timeout: a.timeoutMs } : {}) } } as dl.ScriptStep,
              `기다림: ${dl.selectorLabel(sel)} ${a.gone ? '사라짐' : '나타남'}`,
            );
            return text(a.gone ? '사라짐 확인' : `발견: ${describeNode(found[0])}`);
          }
        }
        if (Date.now() >= deadline) break;
        await dl.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);
      const lines = [`${timeout}ms 안에 ${a.gone ? '사라지지 않음' : '나타나지 않음'}: ${JSON.stringify(cleanSelector(sel))}`];
      if (!last) lines.push(`화면을 한 번도 읽지 못했습니다${lastError ? `: ${lastError}` : ''}`);
      else {
        const screen = await dl.currentScreen(dev).catch(() => undefined);
        if (screen?.activity) lines.push(`지금 화면: ${screen.activity}`);
        const near = a.gone ? [] : dl.similarLabels(last.root, sel);
        // 화면 글자는 앱이 준 데이터다 (지시가 아니다)
        if (near.length) lines.push(`비슷한 후보(화면의 글자): ${near.map((l) => JSON.stringify(l)).join(', ')}`);
      }
      throw new Error(lines.join('\n'));
    },
  );
}

/**
 * 입력 조작 로그 문구. 리포트는 공유되므로 값은 기본으로 가리고, 대상 칸을 확인했고 그 칸이 비밀번호·인증·카드 칸이
 * 아닐 때만 보여 준다 (스크립트 YAML 에는 재실행을 위해 그대로 남는다)
 */
function typedLabel(value: string, field: dl.ViewNode | undefined, target: dl.ViewNode | undefined, clear: boolean): string {
  const names = [field, target].flatMap((n) => (n ? [n.resourceId, n.contentDesc, n.text] : [])).join(' ');
  const plain = !!field && !field.password && !dl.isSecretName(names) && !dl.looksSecret(value);
  const shown = plain ? `"${value}"` : `${dl.MASK} (${value.length}자)`;
  const to = target ?? field;
  return `입력 ${shown}${to ? ` → ${nodeLabel(to)}` : ''}${clear ? ' (기존 글자 지움)' : ''}`;
}

const isTextField = (n: dl.ViewNode) => /EditText|TextField|AutoComplete/i.test(n.className);

/** 셀렉터 없이 입력할 때 받는 칸: 지금 포커스된 입력칸 (못 찾으면 undefined → 값은 가린다) */
async function focusedField(dev: dl.DeviceAdb): Promise<dl.ViewNode | undefined> {
  // 조작 로그용 조회라 이미 떠 있는 에이전트로만 본다 (실패해도 느린 덤프로 넘어가지 않고 값을 가린다)
  const h = await dl.quickDump(dev);
  if (!h) return undefined;
  const stack = [h.root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.focused && isTextField(n)) return n;
    stack.push(...n.children);
  }
  return undefined;
}
