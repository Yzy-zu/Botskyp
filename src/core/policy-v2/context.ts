import { randomUUID } from 'node:crypto';
import type { ToolCtx } from '../tools.js';
import { actorFor } from '../permissions.js';
import type { Chat } from '../permissions.js';
import type { BackendCall, ExecutionContextV2 } from './types.js';

/** Rebuild identity from the authenticated inbox; caller/model actor, role and chat are ignored. */
export async function loadExecutionContext(ctx: ToolCtx, call: BackendCall): Promise<ExecutionContextV2> {
  const row = (await ctx.c.query<{ payload: ToolCtx['msg']; resolved_chat_id: string; source_message_id: string }>(`SELECT i.payload,t.resolved_chat_id,t.source_message_id
    FROM message_turns t JOIN inbox i ON i.turn_id=t.id WHERE t.id=$1`, [ctx.turnId])).rows[0];
  if (!ctx.turnId || !row || row.source_message_id !== ctx.msg.id) throw new Error('Invalid authenticated turn');
  const chat = (await ctx.c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1', [row.resolved_chat_id])).rows[0];
  if (!chat) throw new Error('Unknown authenticated chat');
  const msg = { ...row.payload, id: row.source_message_id, chatId: chat.id, isGroup: chat.isGroup, ts: new Date(row.payload.ts) };
  const actor = await actorFor(ctx.c, msg, ctx.config);
  if (call.callOrigin !== 'llm' && call.providerCallId !== undefined) throw new Error('Provider ID requires llm origin');
  return {
    legacy: { ...ctx, msg, actor, chat }, turnId: ctx.turnId, sourceMessageId: msg.id,
    actor, chat, actorId: actor.id, chatId: chat.id, role: actor.role, callOrigin: call.callOrigin,
    providerCallId: call.providerCallId ?? null, executionKey: '', logicalActionId: randomUUID(),
    parentExecutionId: null, safeRefMap: call.safeRefMap, now: ctx.now, confirmedArgsHash: null,
  };
}
