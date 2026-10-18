import { executionTransaction } from './execution-transaction-v2.js';
import type { ToolCtx } from './tools.js';
import type { SafeRefs } from './safe-refs.js';
import { executeToolV2 } from './policy-v2/executor.js';
import { loadExecutionContext } from './policy-v2/context.js';
import { readSessionV2, coordinateSessionV2 } from './sessions-v2.js';
import type { ToolResult } from './tool-result.js';
/** Backend-only bridge invoked by core.session_confirm; revalidates through Policy R3. */
export async function continueConfirmationV2(ctx: ToolCtx, safeRefMap: SafeRefs): Promise<ToolResult | { status: 'not_consumed' | 'cancel' | 'expired' }> {
  if (ctx.config.ROUTER_MODE !== 'v1_1') return { status: 'not_consumed' };
  const backend = await loadExecutionContext(ctx, { callOrigin: 'session', safeRefMap });
  const session = await readSessionV2(ctx.c, backend.actorId, backend.chatId);
  if (!session || session.kind !== 'confirm' || !session.confirmation_id) return { status: 'not_consumed' };
  if (session.expires_at <= ctx.now) {
    await executionTransaction(ctx, c => coordinateSessionV2(c, ctx.config.ROUTER_MODE, session, backend.legacy.msg.text, ctx.now));
    return { status: 'expired' };
  }
  return executeToolV2(ctx, session.pending_tool, {}, { callOrigin: 'session', safeRefMap, confirmationId: session.confirmation_id });
}
