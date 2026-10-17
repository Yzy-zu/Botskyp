import { executionTransaction } from './execution-transaction-v2.js';
import type { ToolCtx } from './tools.js';
import type { SafeRefs } from './safe-refs.js';
import { executeToolV2 } from './policy-v2/executor.js';
import { loadExecutionContext } from './policy-v2/context.js';
import { decideSessionV2, readSessionV2, coordinateSessionV2 } from './sessions-v2.js';
import type { ToolResult } from './tool-result.js';
/** Backend-only bridge. Not imported by v1 router or Gemini; no direct handlers. */
export async function continueConfirmationV2(ctx: ToolCtx, safeRefMap: SafeRefs): Promise<ToolResult | { status: 'not_consumed' | 'cancel' | 'expired' }> {
  if (ctx.config.ROUTER_MODE !== 'v1_1') return { status: 'not_consumed' };
  const backend = await loadExecutionContext(ctx, { callOrigin: 'session', safeRefMap });
  const session = await readSessionV2(ctx.c, backend.actorId, backend.chatId);
  if (!session || session.kind !== 'confirm') return { status: 'not_consumed' };
  const decision = decideSessionV2(session, backend.legacy.msg.text, ctx.now);
  if (decision.kind === 'cancel' || decision.kind === 'expired') {
    const actual = await executionTransaction(ctx,c=>coordinateSessionV2(c, ctx.config.ROUTER_MODE, session, backend.legacy.msg.text, ctx.now));
    return { status: actual.kind === 'cancel' || actual.kind === 'expired' ? actual.kind : 'not_consumed' };
  }
  if (decision.kind !== 'confirm' || !session.confirmation_id) return { status: 'not_consumed' };
  return executeToolV2(ctx, session.pending_tool, {}, { callOrigin: 'session', safeRefMap, confirmationId: session.confirmation_id });
}
