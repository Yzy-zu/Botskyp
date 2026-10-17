import { bindConfirmationSessionV2 } from '../sessions-v2.js';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import type { ExecutionContextV2, PolicyDecision } from './types.js';

export type PendingConfirmation = {
  id: string; execution_id: string; logical_action_id: string; chat_id: string; actor_id: string;
  tool_name: string; args_hash: string; resolved_args: Record<string, unknown>;
  scope_state: { role: string; permission: string; resourceState: readonly string[]; resources: PolicyDecision['resolvedSafeRefs'] }; expires_at: Date;
  consumed_execution_id: string | null; invalidated: boolean; parent_turn_id: string; parent_args_hash: string; parent_tool_name: string;
};
export async function createPendingConfirmation(c: PoolClient, ctx: ExecutionContextV2, executionId: string, name: string,
  permission: string, decision: PolicyDecision): Promise<string> {
  if (ctx.legacy.config.ROUTER_MODE !== 'v1_1') throw new Error('Confirmation writes disabled');
  const id = (await c.query<{ id: string }>(`INSERT INTO tool_confirmations_v2
    (execution_id,logical_action_id,chat_id,actor_id,tool_name,args_hash,resolved_args,scope_state,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [executionId, ctx.logicalActionId, ctx.chatId, ctx.actorId,
    name, decision.argsHash, JSON.stringify(decision.resolvedArgs), JSON.stringify({ role: ctx.role, permission, resourceState: decision.resourceState, resources: decision.resolvedSafeRefs }),
    new Date(ctx.now.getTime() + product.confirmMinutes * 60_000)])).rows[0]!.id;
  await bindConfirmationSessionV2(c, ctx.legacy.config.ROUTER_MODE, id, decision.confirmationSummary ?? '¿Confirmas esta operación?');
  return id;
}
/** Scoped read used only to recover backend-resolved arguments before policy evaluation. */
export async function readPendingConfirmation(c: PoolClient, ctx: ExecutionContextV2, id: string): Promise<PendingConfirmation | undefined> {
  return (await c.query<PendingConfirmation>(`SELECT p.*,e.turn_id parent_turn_id,e.args_hash parent_args_hash,e.tool_name parent_tool_name FROM tool_confirmations_v2 p
    JOIN tool_executions e ON e.id=p.execution_id
    WHERE p.id=$1 AND p.chat_id=$2 AND p.actor_id=$3`, [id, ctx.chatId, ctx.actorId])).rows[0];
}
/** After policy and replay checks, lock the handle. Consumption is committed with its child receipt. */
export async function consumePendingConfirmation(c: PoolClient, ctx: ExecutionContextV2, id: string): Promise<PendingConfirmation | undefined> {
  if (ctx.legacy.config.ROUTER_MODE !== 'v1_1') throw new Error('Confirmation consumption disabled');
  await c.query('SELECT id FROM tool_confirmations_v2 WHERE id=$1 AND chat_id=$2 AND actor_id=$3 FOR UPDATE', [id, ctx.chatId, ctx.actorId]);
  return readPendingConfirmation(c, ctx, id);
}
