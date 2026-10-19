import { observer } from '../../observer/index.js';
import { runSchoolImportV2 } from '../school-import-v2.js';
import { enqueueDrive } from '../../modules/drive/service.js';
import { confirmationPromptV2 } from '../confirmation-presenter-v2.js';
import { openTimeClarificationV2 } from '../clarification-v2.js';
import { runMediaBridgeV2 } from '../media-bridge-v2.js';
import { beginCollectionV2 } from '../media-collection-v2.js';
import { hasNonEmptyTurnTextV2 } from '../session-input-v2.js';
import { readSessionV2, openClarificationV2 } from '../sessions-v2.js';
import { mergeClarificationArgsV2 } from '../reminder-slots-v2.js';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { executionTransaction } from '../execution-transaction-v2.js';
import { createRegistry } from '../registry.js';
import { createToolRegistryV2, type ToolMetadataV2 } from '../tool-registry-v2.js';
import { executionKey } from '../tool-execution.js';
import type { ToolCtx, Tool } from '../tools.js';
import type { ToolResult } from '../tool-result.js';
import { argumentHash } from '../sessions.js';
import { draft, confirm } from '../../modules/messaging/service.js';
import type { BulkOperation } from '../../modules/messaging/schemas.js';
import { EconomyError } from '../../modules/xp/service.js';
import { loadExecutionContext } from './context.js';
import { evaluateToolPolicy, policyArgsHash } from './evaluate.js';
import { createPendingConfirmation, readPendingConfirmation, consumePendingConfirmation, type PendingConfirmation } from './confirmations.js';
import { normalizeLegacyResult } from './normalize.js';
import type { BackendCall, ExecutionContextV2, PolicyDecision } from './types.js';

const log = pino({ level: 'info' });
// Private registry: v2 has no public handler, registration, dispatch or pre-authorized decision API.
const legacyRegistry = createRegistry();
const catalog = createToolRegistryV2(legacyRegistry);
function metadata(name: string) {
  const tool = catalog.find(t => t.name === name);
  const legacy = legacyRegistry.all().find(t => t.name === name);
  return tool && legacy ? { tool, legacy } : undefined;
}
function result(name: string, domain: string, status: ToolResult['status'], code: string, data: unknown = {}): ToolResult {
  return { toolName: name, domain, status, code, data };
}
export function isDangerousOrDestructive(tool: ToolMetadataV2, legacy: Tool): boolean {
  if (tool.risk === 'DESTRUCTIVE' || legacy.risk === 'destructive') return true;
  if (tool.risk === 'PRIVILEGED') return true;
  if (tool.domain === 'minecraft' && tool.risk !== 'READ') return true;
  if (tool.domain === 'moderation' && tool.risk !== 'READ') return true;
  if (tool.name.startsWith('bulk.') || tool.name === 'messaging.send') return true;
  return false;
}
export function policyDecisionDebug(ctx: Pick<ExecutionContextV2, 'callOrigin'>, name: string, domain: string, d: PolicyDecision, count: number) {
  return { selectedTool: name, domain, policyDecision: d.status, denialCode: d.denialCode,
    requiredConfirmation: d.status === 'needs_confirmation', toolExposureCount: count, callOrigin: ctx.callOrigin };
}
function logDecision(ctx: ExecutionContextV2, name: string, domain: string, d: PolicyDecision, count: number): void {
  observer.emit(()=>({eventType:'POLICY_EVALUATED',stage:'policy',payload:{toolName:name,decision:d,permission:metadata(name)?.tool.permission,risk:metadata(name)?.legacy.risk,input:{callOrigin:ctx.callOrigin,actorId:ctx.actorId,chatId:ctx.chatId,role:ctx.role,sourceMessageId:ctx.sourceMessageId,actor:ctx.actor,chat:ctx.chat,now:ctx.now,executionKey:ctx.executionKey,logicalActionId:ctx.logicalActionId,parentExecutionId:ctx.parentExecutionId,confirmedArgsHash:ctx.confirmedArgsHash,safeRefs:ctx.safeRefMap}}}));
  log.info({...observer.ids(),...policyDecisionDebug(ctx, name, domain, d, count)}, 'Tool policy v2');
}
/** Public read-only evaluation entry; callers never supply a trusted policy decision. */
export async function evaluateToolV2(ctx: ToolCtx, name: string, modelArgs: unknown, call: BackendCall): Promise<PolicyDecision | undefined> {
  const entry = metadata(name);
  if (!entry) return undefined;
  const context = await loadExecutionContext(ctx, call);
  const decision = await evaluateToolPolicy(context, entry.tool, entry.legacy, modelArgs);
  logDecision(context, name, entry.tool.domain, decision, call.toolExposureCount ?? 0);
  return decision;
}

type Replay = { id: string; result_json: ToolResult };
async function replay(ctx: ExecutionContextV2, name: string, requestHash: string): Promise<Replay | undefined> {
  return (await ctx.legacy.c.query<Replay>(`SELECT id,result_json FROM tool_executions WHERE chat_id=$1 AND actor_id=$2 AND
    (execution_key=$3 OR (turn_id=$4 AND provider_call_id=$5 AND $5 IS NOT NULL)
     OR (turn_id=$4 AND tool_name=$6 AND request_hash=$7)) ORDER BY created_at,id LIMIT 1`,
  [ctx.chatId, ctx.actorId, ctx.executionKey, ctx.turnId, ctx.providerCallId, name, requestHash])).rows[0];
}

/** Only this function invokes business handlers for v2; the natural router and sessions use this gate. */
export async function executeToolV2(ctx: ToolCtx, name: string, modelArgs: unknown, call: BackendCall): Promise<ToolResult> {
  const entry = metadata(name);
  if (!entry) return result(name, 'core', 'not_found', 'TOOL_NOT_FOUND');
  // Evaluate-only means NO transaction, confirmation consumption, ledger claim or handler in shadow/v1.
  if (ctx.config.ROUTER_MODE !== 'v1_1') {
    const d = await evaluateToolV2(ctx, name, modelArgs, call);
    return result(name, entry.tool.domain, 'denied', 'DENIED_EXECUTION_MODE', { policyDecision: d?.status });
  }
  return executionTransaction(ctx, async c => {
    // A single admission lock covers every identity key, including provider IDs and logical actions.
    // No external mutations run here; writes enqueue to historical workers.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-v2-execution-admission'))");
    let context = await loadExecutionContext({ ...ctx, c }, call);
    const activeSession = !call.confirmationId ? await readSessionV2(c, context.actorId, context.chatId) : undefined;
    const effectiveArgs = activeSession?.kind === 'clarify' && activeSession.expires_at > context.now && activeSession.pending_tool === name
      ? mergeClarificationArgsV2(activeSession.partial_args, modelArgs)
      : modelArgs;
    let pending: PendingConfirmation | undefined;
    if (call.confirmationId) pending = await readPendingConfirmation(c, context, call.confirmationId);
    if (pending) context = { ...context, logicalActionId: pending.logical_action_id, parentExecutionId: pending.execution_id,
      confirmedArgsHash: pending.args_hash };
    observer.emit(()=>({eventType:'TOOL_PROPOSED',stage:'policy.arguments',payload:{toolName:name,modelArgs,effectiveArgs,call,safeRefs:call.safeRefMap}}));
    const decision = await evaluateToolPolicy(context, entry.tool, entry.legacy, effectiveArgs,
      pending?.tool_name === name ? pending.resolved_args : undefined, pending?.scope_state.resources ?? []);
    const hash = pending?.tool_name === name ? pending.args_hash : decision.argsHash;
    context = { ...context, executionKey: executionKey({ turnId: context.turnId, chatId: context.chatId,
      actorId: context.actorId, sourceMessageId: context.sourceMessageId, toolName: name, argsHash: hash,
      callOrigin: context.callOrigin, ...(context.providerCallId === null ? {} : { providerCallId: context.providerCallId }) }) };
    logDecision(context, name, entry.tool.domain, decision, call.toolExposureCount ?? 0);
    const requestHash = argumentHash(name, effectiveArgs);
    const previous = await replay(context, name, requestHash);
    if (previous) return previous.result_json;
    // Source/tool/hash barrier is independent of origin/provider; resolve first, then compare.
    const effect = (await c.query<Replay>(`SELECT id,result_json FROM tool_executions WHERE chat_id=$1 AND actor_id=$2
      AND source_message_id=$3 AND tool_name=$4 AND args_hash=$5`, [context.chatId, context.actorId, context.sourceMessageId, name, hash])).rows[0];
    if (effect) return effect.result_json;
    if (pending && call.confirmationId) pending = await consumePendingConfirmation(c, context, call.confirmationId);
    if (pending?.consumed_execution_id) {
      return (await c.query<Replay>('SELECT id,result_json FROM tool_executions WHERE id=$1', [pending.consumed_execution_id])).rows[0]!.result_json;
    }
    let confirmationFailure: string | null = null;
    if (call.confirmationId) {
      if (!pending || pending.tool_name !== name) confirmationFailure = 'DENIED_CONFIRMATION_NOT_FOUND';
      else if (pending.args_hash !== pending.parent_args_hash || pending.tool_name !== pending.parent_tool_name) confirmationFailure = 'DENIED_CONFIRMATION_ARGS_CHANGED';
      else if (pending.invalidated) confirmationFailure = 'DENIED_CONFIRMATION_INVALIDATED';
      else if (pending.expires_at <= context.now) confirmationFailure = 'DENIED_CONFIRMATION_EXPIRED';
      else if (pending.parent_turn_id === context.turnId || context.callOrigin !== 'session') confirmationFailure = 'DENIED_CONFIRMATION_SECOND_TURN';
      else if (!hasNonEmptyTurnTextV2(context.legacy.msg.text)) confirmationFailure = 'DENIED_CONFIRMATION_INPUT';
      else if (pending.scope_state.role !== context.role || pending.scope_state.permission !== entry.tool.permission) confirmationFailure = 'DENIED_CONFIRMATION_STATE_CHANGED';
      else if (policyArgsHash(context, name, pending.resolved_args, pending.scope_state.resourceState) !== pending.args_hash || (['allow','needs_confirmation'].includes(decision.status) && decision.argsHash !== pending.args_hash)) confirmationFailure = 'DENIED_CONFIRMATION_ARGS_CHANGED';
    }
    if (confirmationFailure && (!pending || pending.tool_name !== name || pending.parent_turn_id === context.turnId || pending.args_hash !== pending.parent_args_hash || pending.tool_name !== pending.parent_tool_name)) {
      // Invalid/unrelated parent must not be attached to an unrelated tool/hash in the immutable ledger.
      context = { ...context, parentExecutionId: null, logicalActionId: randomUUID() };
    }
    const id = randomUUID();
    const risk = entry.legacy.risk;
    const claim = result(name, entry.tool.domain, 'uncertain', 'EXECUTION_IN_PROGRESS');
    await c.query(`INSERT INTO tool_executions(id,turn_id,call_origin,provider_call_id,execution_key,source_message_id,
      chat_id,actor_id,tool_name,risk_level,args_hash,status,result_json,parent_execution_id,logical_action_id,request_hash,
      input_args,policy_decision,policy_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14,$15,$16,$17,$18)`,
    [id, context.turnId, context.callOrigin, context.providerCallId, context.executionKey, context.sourceMessageId,
      context.chatId, context.actorId, name, risk, hash, JSON.stringify(claim), context.parentExecutionId, context.logicalActionId, requestHash,
      JSON.stringify(modelArgs ?? {}), decision.status, decision.denialCode ?? null]);
    async function finish(value: ToolResult): Promise<ToolResult> {
      if (pending && confirmationFailure !== 'DENIED_CONFIRMATION_INPUT' && ['ok','queued','uncertain','error','denied','qa_suppressed'].includes(value.status)) {
        const sessionStatus = pending.expires_at <= context.now ? 'expired' : pending.invalidated ? 'cancelled' : 'done';
        await observer.rows(c.query("UPDATE sessions_v2 SET status=$2,version=version+1 WHERE confirmation_id=$1 AND status='active' RETURNING *", [pending.id, sessionStatus]),'session.persisted','SESSION_AFTER');
      }
      if (activeSession?.kind === 'clarify' && activeSession.pending_tool === name && ['ok','queued'].includes(value.status)) {
        await observer.rows(c.query("UPDATE sessions_v2 SET status='done',version=version+1 WHERE id=$1 AND status='active' RETURNING *", [activeSession.id]),'session.persisted','SESSION_AFTER');
      }
      await c.query('UPDATE tool_executions SET status=$2,result_json=$3,finished_at=clock_timestamp() WHERE id=$1', [id, value.status, JSON.stringify(value)]);
      observer.emit(()=>({eventType:'TOOL_RESULT',stage:'handler',payload:{executionId:id,toolName:name,result:value,transaction:'pending_commit'}}));
      return value;
    }
    if (confirmationFailure) return finish(result(name, entry.tool.domain, 'denied', confirmationFailure));
    if (decision.status !== 'allow' && decision.status !== 'needs_confirmation') {
      if (pending) await c.query('UPDATE tool_confirmations_v2 SET invalidated=true WHERE id=$1', [pending.id]);
      if(decision.status==='needs_clarification')await openTimeClarificationV2(context,name,effectiveArgs,decision.denialCode ?? '');
      const data:Record<string,unknown>={...(decision.missingSlots?{missingSlots:decision.missingSlots}:{})};
      if(decision.status==='needs_clarification' && decision.missingSlots?.length && !['AMBIGUOUS_HOUR','MISSING_DATE'].includes(decision.denialCode ?? '')){
        await openClarificationV2(c,ctx.config.ROUTER_MODE,{actorId:context.actorId,chatId:context.chatId,pendingTool:name,partialArgs:effectiveArgs && typeof effectiveArgs==='object'?effectiveArgs as Record<string,unknown>:{},missingSlots:decision.missingSlots.map(slot=>({kind:'required',field:slot.field})),prompt:`Falta: ${decision.missingSlots.map(s=>s.field).join(', ')}`,code:decision.denialCode ?? 'MISSING_ARGUMENTS',now:ctx.now});
      }
      if(decision.denialCode==='DENIED_INSUFFICIENT_XP'){
        const balance=(await c.query<{balance:number}>('SELECT balance FROM wallets WHERE user_id=$1',[context.actorId])).rows[0]?.balance ?? 0;
        const cost=Number(decision.resolvedArgs.bet ?? decision.resolvedArgs.amount ?? 0);
        if(cost>0){data.balance=balance;data.shortfall=Math.max(0,cost-balance);}
      }
      return finish(result(name, entry.tool.domain, decision.status, decision.denialCode ?? 'DENIED_POLICY',data));
    }
    if (decision.status === 'needs_confirmation' && !pending) {
      // Terminal parent must exist before confirmation FK; no business handler has run.
      const confirmationId = await createPendingConfirmation(c, context, id, name, entry.tool.permission, decision);
      return finish(result(name, entry.tool.domain, 'needs_confirmation', 'NEEDS_CONFIRMATION', { confirmationId, prompt:await confirmationPromptV2(context,name,decision) }));
    }
    // QA Safety Gate: Enforce central barrier preventing destructive external mutations in SAFE mode.
    const isSafeMode = context.legacy.msg.qaMode === 'SAFE';
    if (isSafeMode && isDangerousOrDestructive(entry.tool, entry.legacy)) {
      const suppressed: ToolResult = {
        toolName: name,
        domain: entry.tool.domain,
        status: 'qa_suppressed',
        code: 'QA_SUPPRESSED',
        data: {
          gateDecision: 'WOULD_EXECUTE',
          qaSafetySuppressed: true,
          toolName: name,
          risk: entry.tool.risk,
          args: decision.resolvedArgs,
        },
        presentation: `[QA SAFE] Operación ${name} interceptada por el gate de seguridad (WOULD_EXECUTE). No se ejecutaron efectos secundarios reales.`,
      };
      await finish(suppressed);
      if (pending) await c.query('UPDATE tool_confirmations_v2 SET consumed_execution_id=$2 WHERE id=$1', [pending.id, id]);
      return suppressed;
    }
    await c.query('SAVEPOINT v2_handler');
    let normalized: ToolResult;
    const handlerStarted=performance.now();
    observer.emit(()=>({eventType:'TOOL_STARTED',stage:'handler',payload:{executionId:id,toolName:name,handler:entry.legacy.name,resolvedArgs:decision.resolvedArgs,resolvedSafeRefs:decision.resolvedSafeRefs}}));
    try {
      let outcome;
      if(name==='school.schedule_import')outcome=await runSchoolImportV2(context,decision);
      else if(name==='school.schedule_propose'){
        const preview=await entry.legacy.run(context.legacy,decision.resolvedArgs);
        outcome=preview.ok?await legacyRegistry.all().find(t=>t.name==='school.schedule_commit')!.run(context.legacy,preview.facts):preview;
      }else if(name==='drive.upload'){
        const artifact=decision.resolvedSafeRefs.find(r=>r.kind==='artifactRef');
        if(!artifact)outcome={ok:false as const,message:'Selecciona un archivo propio vigente.',kind:'user' as const};
        else outcome=await enqueueDrive(context.legacy,'upload',undefined,artifact.id);
      }else if(name==='media.process')outcome=await runMediaBridgeV2(context,decision);
      else if(name==='media.collect')outcome=await beginCollectionV2(context,decision);
      else if (['bulk.nuclear','bulk.broadcast','messaging.send'].includes(name)) {
        const kind = name === 'bulk.nuclear' ? 'nuclear' : name === 'bulk.broadcast' ? 'broadcast' : 'message';
        const prepared = await draft(context.legacy, kind, String(decision.resolvedArgs.text),
          Array.isArray(decision.resolvedArgs.destinations) ? decision.resolvedArgs.destinations as string[] : [],
          Number(decision.resolvedArgs.count ?? 1), false);
        if (!prepared.ok) outcome = prepared;
        else {
          const op = (await c.query<BulkOperation>('SELECT * FROM bulk_ops WHERE id=$1', [prepared.facts.id])).rows[0]!;
          outcome = await confirm(context.legacy, op.id, op.args_hash);
        }
      } else outcome = await entry.legacy.run(context.legacy, decision.resolvedArgs);
      observer.emit(()=>({eventType:risk==='read'?'TOOL_RESULT':'BUSINESS_MUTATION',stage:'handler.receipt',payload:{executionId:id,toolName:name,risk,args:decision.resolvedArgs,outcome,latencyMs:performance.now()-handlerStarted,transaction:'pending_commit'}}));
      normalized = await normalizeLegacyResult(context, entry.tool, outcome, decision.resolvedArgs);
      if (!outcome.ok) {
        observer.emit({eventType:'TRANSACTION_ROLLBACK',stage:'handler.savepoint',payload:{executionId:id,toolName:name,outcome:'legacy_rejected'}});
        await c.query('ROLLBACK TO SAVEPOINT v2_handler');
        // Keep the sanitized user-facing failure; the rolled-back handler produced no effect.
        normalized = {...normalized,status:'error',code:'LEGACY_REJECTED'};
      } else if (risk !== 'read') await c.query('INSERT INTO audit_log(actor_id,chat_id,action) VALUES($1,$2,$3)', [context.actorId, context.chatId, name]);
    } catch (error) {
      observer.emit({eventType:'TOOL_ERROR',stage:'handler',payload:{executionId:id,toolName:name,error,latencyMs:performance.now()-handlerStarted}});
      observer.emit({eventType:'TRANSACTION_ROLLBACK',stage:'handler.savepoint',payload:{executionId:id,toolName:name,outcome:'rollback_requested'}});
      await c.query('ROLLBACK TO SAVEPOINT v2_handler');
      await c.query('RELEASE SAVEPOINT v2_handler');
      // All supported effects are transactional DB mutations or durable queues, never remote writes.
      const isEconomy = error instanceof EconomyError;
      const isNoGame = isEconomy && ['games.status', 'games.cancel'].includes(name) && error.message.includes('No tienes una partida disponible');
      const failure = result(name, entry.tool.domain, 'error', isNoGame ? 'NO_ACTIVE_GAME' : isEconomy ? 'DOMAIN_REJECTED' : 'HANDLER_ERROR', isEconomy ? { message: error.message } : {});
      if (isEconomy && error.message) failure.presentation = error.message;
      if (name === 'web.search') failure.presentation = 'No pude completar la búsqueda en este momento. Inténtalo más tarde.';
      await finish(failure);
      if (pending) await c.query('UPDATE tool_confirmations_v2 SET consumed_execution_id=$2 WHERE id=$1', [pending.id, id]);
      return failure;
    }
    await c.query('RELEASE SAVEPOINT v2_handler');
    await finish(normalized);
    if (pending) await c.query('UPDATE tool_confirmations_v2 SET consumed_execution_id=$2 WHERE id=$1', [pending.id, id]);
    return normalized;
  });
}
