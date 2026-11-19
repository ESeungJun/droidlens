import { confirmChat, resolveClaude, sendChat, stopChat, type ChatRequest } from '../chat';
import { agentsSrc, mcpScript, send, type Handle } from '../context';

/** 앱 안의 에이전트 대화창 (Claude Code 헤드리스). 실제 실행은 ../chat.ts */
export function register(handle: Handle): void {
  handle('chatStatus', async () => {
    const c = await resolveClaude();
    return { version: c.version };
  });
  handle('chatSend', async (req: ChatRequest) => {
    await sendChat(req, { execPath: process.execPath, mcpScript: mcpScript(), agentsDir: agentsSrc() }, (e) => send('chat:event', e));
    return true;
  });
  handle('chatStop', async () => stopChat());
  handle('chatConfirm', async (id: string, approve: boolean) => confirmChat(id, approve));
}
