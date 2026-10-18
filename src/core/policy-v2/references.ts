import { schoolDestination } from '../../modules/school/automation.js';
import { resolveArtifactForOperation, type ArtifactOperation } from '../artifact-resolution-v2.js';
import { product } from '../../../config/product.js';
import { destinationAllowed } from '../../modules/messaging/access.js';
import { lastChatArtifact } from '../chat-artifacts.js';
import { refKinds, type RefKind } from '../safe-refs.js';
import type { ExecutionContextV2, PolicyDecision } from './types.js';

type Resource = { owner_id: string | null; state?: string; name?: string; status?: string; closes_at?: Date };
/** Fixed queries only. Snapshots are hints: every resolved ID is checked against live scoped data. */
export async function liveResource(ctx: ExecutionContextV2, kind: RefKind, id: string): Promise<Resource | undefined> {
  const c = ctx.legacy.c, chat = ctx.chatId, actor = ctx.actorId;
  switch (kind) {
    case 'memberRef': return (await c.query<Resource>(`SELECT user_id owner_id FROM group_memberships WHERE chat_id=$1 AND user_id=$2 AND active
      AND last_seen_at>clock_timestamp()-$3::int*interval '1 millisecond'`, [chat, id, product.membershipMaxAgeMs])).rows[0];
    case 'noteRef': return (await c.query<Resource>('SELECT author_id owner_id,jsonb_build_array(body,updated_at)::text state FROM notes WHERE chat_id=$1 AND id::text=$2 AND deleted_at IS NULL', [chat, id])).rows[0];
    case 'reminderRef': return (await c.query<Resource>("SELECT owner_id,status,jsonb_build_array(body,due_at,status)::text state FROM reminders WHERE chat_id=$1 AND id::text=$2 AND owner_id=$3 AND status='pending'", [chat, id, actor])).rows[0];
    case 'memoryRef': return (await c.query<Resource>('SELECT user_id owner_id,body state FROM user_memories WHERE id::text=$1 AND user_id=$2', [id, actor])).rows[0];
    case 'pollRef': return (await c.query<Resource>('SELECT author_id owner_id,status,closes_at,jsonb_build_array(question,status,closes_at)::text state FROM polls WHERE chat_id=$1 AND id::text=$2', [chat, id])).rows[0];
    case 'taskRef': return (await c.query<Resource>('SELECT created_by owner_id,jsonb_build_array(title,updated_at)::text state FROM school_tasks WHERE chat_id=$1 AND id::text=$2 AND deleted_at IS NULL', [chat, id])).rows[0];
    case 'subjectRef': return (await c.query<Resource>('SELECT NULL::text owner_id,name,name state FROM school_subjects WHERE chat_id=$1 AND id::text=$2 AND active', [chat, id])).rows[0];
    case 'driveRef': return (await c.query<Resource>('SELECT actor_id owner_id FROM drive_entries WHERE chat_id=$1 AND id::text=$2 AND actor_id=$3 AND expires_at>clock_timestamp()', [chat, id, actor])).rows[0];
    case 'opRef': return (await c.query<Resource>(`SELECT actor_id owner_id,status FROM bulk_ops WHERE chat_id=$1 AND id::text=$2 AND actor_id=$3
      UNION ALL SELECT owner_id,status FROM jobs WHERE chat_id=$1 AND id::text=$2 AND owner_id=$3 AND kind='drive'`, [chat, id, actor])).rows[0];
    case 'destinationRef': {
      if(id.startsWith('school:'))return await schoolDestination(c,ctx.legacy.config,id.slice(7),actor)?{owner_id:actor,state:id}:undefined;
      const d = (await c.query<{ target_id: string }>('SELECT target_id FROM messaging_destinations WHERE id::text=$1', [id])).rows[0];
      return d && await destinationAllowed(c, ctx.legacy.config, d.target_id) ? { owner_id: actor, state: d.target_id } : undefined;
    }
    case 'artifactRef': return (await c.query<Resource>(`SELECT a.actor_id owner_id FROM chat_artifacts a
      LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
      WHERE a.chat_id=$1 AND a.id::text=$2 AND a.actor_id=$3 AND a.expires_at>clock_timestamp()
      AND ((m.data IS NOT NULL AND m.expires_at>clock_timestamp()) OR (s.data IS NOT NULL AND s.expires_at>clock_timestamp()))`, [chat, id, actor])).rows[0];
  }
}
export type ResolvedReferences = {
  args: Record<string, unknown>; refs: PolicyDecision['resolvedSafeRefs']; ownership: PolicyDecision['ownership'];
  failure?: 'not_found' | 'needs_clarification' | 'incompatible';
};
export async function resolveReferences(ctx: ExecutionContextV2, args: Record<string, unknown>, artifactOperation?: string, allowNewSubjects=false): Promise<ResolvedReferences> {
  const refs: { ref: string; kind: RefKind; id: string }[] = [], ownership: { kind: RefKind; id: string; ownerId: string | null; own: boolean }[] = [];
  let failure: ResolvedReferences['failure'];
  async function walk(value: unknown, field: string): Promise<unknown> {
    if (Array.isArray(value)) {
      // Preserve source order in both resolved arguments and the collected provenance.
      const resolved:unknown[]=[];
      for(const item of value)resolved.push(await walk(item,field==='destinations'?'destinationRef':field==='artifactRefs'?'collectionArtifactRef':field));
      return resolved;
    }
    if (value !== null && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await walk(v, k)])));
    if (typeof value !== 'string') return value;
    if(allowNewSubjects && field==='subject' && !value.startsWith('subjectRef_'))return value;
    const kind = (field==='collectionArtifactRef'?'artifactRef':refKinds.find(k => field === k))
      ?? (field === 'target' && value.startsWith('memoryRef_') ? 'memoryRef' : undefined)
      ?? (field === 'subject' && value.startsWith('subjectRef_') ? 'subjectRef' : undefined);
    if (value === 'SELF' && field === 'memberRef') return ctx.actorId;
    if (!kind && field !== 'subject') return value;
    if((field==='artifactRef' || field==='collectionArtifactRef') && artifactOperation){
      const selected=await resolveArtifactForOperation(artifactOperation as ArtifactOperation,{c:ctx.legacy.c,...ctx,...(field==='collectionArtifactRef'?{sourceMessageId:''}:ctx.legacy.msg.quoted?{quotedMessageId:ctx.legacy.msg.quoted.id}:{})},value);
      if(selected.status!=='ok'){failure=selected.status==='not_found'?'not_found':selected.status==='incompatible'?'incompatible':'needs_clarification';return value;}
      refs.push({ref:value,kind:'artifactRef',id:selected.artifact.id});
      ownership.push({kind:'artifactRef',id:selected.artifact.id,ownerId:ctx.actorId,own:true});
      return selected.artifact.id;
    }
    const last = field === 'artifactRef' && value === 'A_LAST' ? await lastChatArtifact(ctx.legacy.c, ctx.chatId, ctx.actorId) : undefined;
    const resolved = last ? { status: 'ok' as const, id: last.id, kind: 'artifactRef' as const } : kind ? ctx.safeRefMap.resolve(value, kind, ctx)
      : ctx.safeRefMap.resolveName(value, 'subjectRef', ctx);
    if (resolved.status !== 'ok') { failure = resolved.status; return value; }
    const actualKind = kind ?? 'subjectRef';
    const live = await liveResource(ctx, actualKind, resolved.id);
    if (!live) { failure = 'not_found'; return value; }
    refs.push({ ref: value, kind: actualKind, id: resolved.id });
    ownership.push({ kind: actualKind, id: resolved.id, ownerId: live.owner_id, own: live.owner_id === ctx.actorId });
    return field === 'subject' ? live.name : resolved.id;
  }
  const resolved = await walk(args, '') as Record<string, unknown>;
  return { args: resolved, refs, ownership, ...(failure ? { failure } : {}) };
}
