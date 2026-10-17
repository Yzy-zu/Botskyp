import { product } from '../../../config/product.js';
import { permitted, moduleEnabled, privateEligible } from '../permissions.js';
import type { ToolMetadataV2 } from '../tool-registry-v2.js';
import type { Tool } from '../tools.js';
import { argumentHash } from '../sessions.js';
import { liveResource, resolveReferences } from './references.js';
import { adapterAvailable, legacyArguments } from './arguments.js';
import { businessEligibility, economicEligibility, cooldownEligibility } from './eligibility.js';
import type { ExecutionContextV2, PolicyDecision, EvaluationStatus } from './types.js';

export function policyArgsHash(ctx: Pick<ExecutionContextV2, 'actorId' | 'chatId'>, name: string, resolvedArgs: unknown, resourceState: readonly string[] = []): string {
  return argumentHash(name, { resolvedArgs, scope: { actorId: ctx.actorId, chatId: ctx.chatId, resourceState } });
}
/** No handlers, sessions, writes, wallet creation, reservations or external calls. */
export async function evaluateToolPolicy(ctx: ExecutionContextV2, tool: ToolMetadataV2, legacy: Tool, modelArgs: unknown,
  confirmedResolvedArgs?: Record<string, unknown>, confirmationResources: PolicyDecision['resolvedSafeRefs'] = []): Promise<PolicyDecision> {
  const gates: string[] = [];
  const resourceState: string[] = [];
  let args: Record<string, unknown> = {}, refs: PolicyDecision['resolvedSafeRefs'] = [], ownership: PolicyDecision['ownership'] = [];
  const decision = (status: EvaluationStatus, code: string | null = null): PolicyDecision => ({
    status, resolvedArgs: args, denialCode: code, argsHash: policyArgsHash(ctx, tool.name, args, resourceState), resourceState, ownership, resolvedSafeRefs: refs, gates,
    confirmationSummary: status !== 'needs_confirmation' ? null : tool.name === 'bulk.nuclear'
      ? `${args.count} mensajes en el grupo actual, sin menciones ni expulsiones; mínimo ${product.nuclearGapMs / 1000} s entre envíos. Contenido exacto: ${String(args.text)}`
      : `${tool.name}: ${JSON.stringify(args)}`,
  });
  gates.push('system');
  const flags = (await ctx.legacy.c.query<{ key: string; value: unknown }>('SELECT key,value FROM system_flags')).rows;
  resourceState.push(argumentHash('system_state', { emergency: flags.some(f => f.key === 'emergency' && f.value === true), maintenance: flags.some(f => f.key === 'maintenance' && f.value === true) }));
  if (flags.some(f => f.key === 'emergency' && f.value === true) && tool.name !== 'control.reactivate') return decision('denied', 'DENIED_EMERGENCY');
  if (flags.some(f => f.key === 'maintenance' && f.value === true) && ctx.role !== 'owner') return decision('denied', 'DENIED_MAINTENANCE');
  gates.push('chat');
  if (!ctx.chat.enabled) return decision('denied', 'DENIED_CHAT_DISABLED');
  if (tool.scope !== 'both' && (tool.scope === 'group') !== ctx.chat.isGroup) return decision('denied', 'DENIED_CHAT_SCOPE');
  if (!ctx.chat.isGroup && !await privateEligible(ctx.legacy.c, ctx.actor)) return decision('denied', 'DENIED_PRIVATE_INELIGIBLE');
  gates.push('module');
  if (!moduleEnabled(ctx.chat, tool.requiredModule, ctx.legacy.config)
    || (tool.requiredModule === 'minecraft' && !ctx.legacy.config.MINECRAFT_ENABLED)
    || (tool.requiredModule === 'drive' && !ctx.legacy.config.DRIVE_ENABLED)) return decision('denied', 'DENIED_MODULE_DISABLED');
  gates.push('identity_membership');
  if (ctx.actorId.endsWith('@lid')) return decision('denied', 'DENIED_IDENTITY_UNRESOLVED');
  if (ctx.chat.isGroup && ctx.role !== 'owner' && !ctx.actor.groupMember) return decision('denied', 'DENIED_MEMBERSHIP');
  gates.push('permission');
  if (!permitted(ctx.actor, ctx.chat, tool.permission)) return decision('denied', 'DENIED_PERMISSION');
  gates.push('safe_refs');
  if (confirmedResolvedArgs) {
    args = { ...confirmedResolvedArgs };
  } else {
    const parsed = tool.modelArgsSchema.safeParse(modelArgs);
    if (!parsed.success) return decision('denied', 'INVALID_MODEL_ARGUMENTS');
    const resolved = await resolveReferences(ctx, parsed.data as Record<string, unknown>);
    args = resolved.args; refs = resolved.refs; ownership = resolved.ownership;
    if (resolved.failure) return decision(resolved.failure, resolved.failure === 'not_found' ? 'REF_NOT_FOUND' : 'REF_AMBIGUOUS');
  }
  gates.push('ownership');
  // Stored refs were resolved by backend on turn A; validate every resource again without a model snapshot.
  if (confirmedResolvedArgs) {
    refs = confirmationResources;
    const owners: { kind: typeof refs[number]['kind']; id: string; ownerId: string | null; own: boolean }[] = [];
    for (const resource of refs) {
      const live = await liveResource(ctx, resource.kind, resource.id);
      if (!live) return decision('not_found', 'REF_NOT_FOUND');
      owners.push({ kind: resource.kind, id: resource.id, ownerId: live.owner_id, own: live.owner_id === ctx.actorId });
    }
    ownership = owners;
  }
  for (const resource of ownership) {
    const live = await liveResource(ctx, resource.kind, resource.id);
    if (!live) return decision('not_found', 'REF_NOT_FOUND');
    if (live.state) resourceState.push(argumentHash('resource_version', { kind: resource.kind, id: resource.id, state: live.state }));
  }
  resourceState.sort();
  if (tool.name === 'memory.forget') {
    const memories = (await ctx.legacy.c.query('SELECT id,body FROM user_memories WHERE user_id=$1 ORDER BY id', [ctx.actorId])).rows;
    resourceState.push(argumentHash('personal_memories', memories));
  }
  if (['notes.edit','notes.delete'].includes(tool.name) && ownership.some(o => o.kind === 'noteRef' && !o.own)
    && !(ctx.chat.isGroup && permitted(ctx.actor, ctx.chat, 'notes.manage_shared'))) return decision('denied', 'DENIED_OWNERSHIP');
  if (tool.name === 'school.task_edit' && ownership.some(o => o.kind === 'taskRef' && !o.own)
    && !permitted(ctx.actor, ctx.chat, 'school.manage')) return decision('denied', 'DENIED_OWNERSHIP');
  gates.push('business');
  if (!adapterAvailable(tool.name)) return decision('denied', 'DENIED_ADAPTER_UNAVAILABLE');
  if (!confirmedResolvedArgs && tool.name === 'polls.vote' && typeof args.option === 'string') {
    const options = (await ctx.legacy.c.query<{ idx: number }>('SELECT idx FROM poll_options WHERE poll_id=$1 AND lower(label)=lower($2)', [args.pollRef, args.option])).rows;
    if (options.length !== 1) return decision('needs_clarification', 'POLL_OPTION_AMBIGUOUS');
    args.option = options[0]!.idx;
  }
  const translated = confirmedResolvedArgs ? legacy.args.safeParse(args) : null;
  if (translated) {
    if (!translated.success) return decision('denied', 'INVALID_ARGUMENTS');
    args = translated.data as Record<string, unknown>;
  } else {
    const result = legacyArguments(ctx, legacy, args);
    if (result.status !== 'ok') return decision(result.status, result.code);
    args = result.args;
  }
  const business = await businessEligibility(ctx, tool.name, args);
  if (business) return decision('denied', business);
  gates.push('economic');
  const economic = await economicEligibility(ctx, tool.name, args);
  if (economic) return decision('denied', economic);
  gates.push('cooldown');
  const cooldown = await cooldownEligibility(ctx, tool.name, args);
  if (cooldown) return decision('denied', cooldown);
  gates.push('confirmation');
  // A supplied hash is not authorization; execute checks a stored, scoped, fresh second-turn confirmation.
  return decision(tool.confirmationPolicy === 'none' ? 'allow' : 'needs_confirmation');
}
