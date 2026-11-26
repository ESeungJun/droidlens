import { startClaude, type ClaudeContext, type ClaudeEvent, type ClaudeHandle } from './claude';

/**
 * 앱 안의 에이전트 대화창. Claude Code 헤드리스 실행(claude.ts)에 DroidLens MCP 서버와 전용 에이전트를 붙인다.
 * 대화는 --resume <session_id>로 이어간다.
 */

export { resolveClaude } from './claude';
export type ChatEvent = ClaudeEvent;

export interface ChatRequest {
  /** 렌더러가 정한 실행 번호. 이 실행의 모든 이벤트에 실어 보내 이전 실행의 늦은 이벤트와 구분하게 한다 */
  runId: number;
  message: string;
  agent: string;
  sessionId?: string;
  serial?: string;
  packageName?: string;
}

let current: ClaudeHandle | null = null;

/** 대화창의 승인·거부 버튼. 지금 실행의 요청이 아니거나 이미 답한 요청이면 false */
export function confirmChat(id: string, approve: boolean): boolean {
  return !!current && current.answer(id, approve);
}
// 실행 세대. claude 를 찾고 에이전트를 불러오는 동안(프로세스가 아직 없을 때) 누른 중지도 반영하려고 쓴다
let generation = 0;

export function stopChat(): void {
  generation++;
  current?.stop();
  current = null;
}

export async function sendChat(req: ChatRequest, ctx: ClaudeContext, emitRaw: (e: ChatEvent & { run: number }) => void): Promise<void> {
  const emit = (e: ChatEvent) => emitRaw({ ...e, run: req.runId });
  stopChat();
  const mine = ++generation;
  const context = [
    '이 대화는 DroidLens 데스크톱 앱의 에이전트 대화창에서 진행된다. 사용자는 같은 화면에서 기기 미러링을 보고 있다.',
    req.serial ? `연결된 기기 serial: ${req.serial}` : '연결된 기기 없음',
    '앱 데이터 삭제·DB 쓰기·앱 밖 URI 열기는 호출하면 대화창에 승인·거부 버튼이 떠서 사용자가 직접 정한다. 거부되거나 시간이 지나면 같은 호출을 되풀이하지 않는다.',
    req.packageName ? `사용자가 선택한 앱: ${req.packageName}` : '',
    '답변은 한국어로, 짧고 구체적으로.',
  ]
    .filter(Boolean)
    .join('\n');
  const handle = await startClaude(
    {
      agent: req.agent,
      message: req.message,
      sessionId: req.sessionId,
      context,
      allowedTools: ['mcp__droidlens__*'],
      mcpEnv: {
        ...(req.serial ? { DROIDLENS_SERIAL: req.serial } : {}),
        // 사용자가 고른 앱: 이 앱의 커스텀 스킴 딥링크만 확인 없이 연다
        ...(req.packageName ? { DROIDLENS_APP: req.packageName } : {}),
      },
      workDir: 'chat',
    },
    ctx,
    emit,
    () => mine !== generation,
  );
  if (!handle) return;
  if (mine !== generation) return handle.stop();
  current = handle;
  void handle.exited.then(() => {
    if (current === handle) current = null;
  });
}
