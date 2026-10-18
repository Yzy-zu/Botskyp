import type { PoolClient } from 'pg';
import { conversions, extensions, type Operation } from '../modules/media/catalog.js';
import { artifactsForTurn, type ArtifactRecord } from './chat-artifacts.js';
import type { SafeRefs } from './safe-refs.js';
export type ArtifactOperation = Operation | 'resend' | 'vision';
export type ArtifactScopeV2 = { c: PoolClient; chatId: string; actorId: string; sourceMessageId: string; quotedMessageId?: string; now: Date; safeRefMap: SafeRefs; allowRecentVision?: boolean };
export type ArtifactResolution = { status: 'ok'; artifact: ArtifactRecord; ref: string } | { status: 'not_found' | 'incompatible' | 'needs_clarification' };
export function artifactCompatible(operation: ArtifactOperation, artifact: Pick<ArtifactRecord, 'mime'>): boolean {
  if (operation === 'resend') return true;
  if (operation === 'vision') return artifact.mime.startsWith('image/');
  return conversions[operation].inputs.includes(extensions[artifact.mime] ?? '');
}
/** Explicit model references select exactly one file; implicit input is CURRENT/REPLIED only. */
export async function resolveArtifactForOperation(operation: ArtifactOperation, context: ArtifactScopeV2, explicitRef?: string): Promise<ArtifactResolution> {
  const candidates = await artifactsForTurn(context.c, {...context,resolveTextResultSource:true});
  if(explicitRef && !['A_CURRENT','A_REPLY','A_LAST'].includes(explicitRef)){
    const resolved=context.safeRefMap.resolve(explicitRef,'artifactRef',context);
    if(resolved.status!=='ok')return {status:resolved.status};
    const artifact=(await context.c.query<ArtifactRecord>(`SELECT a.* FROM chat_artifacts a
      LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
      WHERE a.id=$1 AND a.chat_id=$2 AND a.actor_id=$3 AND a.expires_at>$4
        AND ((m.data IS NOT NULL AND m.expires_at>$4) OR (s.data IS NOT NULL AND s.expires_at>$4))`,[resolved.id,context.chatId,context.actorId,context.now])).rows[0];
    return !artifact?{status:'not_found'}:artifactCompatible(operation,artifact)?{status:'ok',artifact,ref:explicitRef}:{status:'incompatible'};
  }
  const selected=explicitRef==='A_LAST'?candidates.recent.slice(0,1):explicitRef==='A_REPLY'?candidates.reply:
    explicitRef==='A_CURRENT'?candidates.current:candidates.current.length?candidates.current:context.quotedMessageId?candidates.reply:[];
  if(!selected.length)return {status:'not_found'};
  if(selected.length!==1)return {status:'needs_clarification'};
  const artifact=selected[0]!;
  return artifactCompatible(operation,artifact)?{status:'ok',artifact,ref:explicitRef ?? (candidates.current.length?'A_CURRENT':'A_REPLY')}:{status:'incompatible'};
}

/** The initial request may see CURRENT/REPLIED vision, never historical image bytes. */
export async function resolveVisionArtifactV2(context: ArtifactScopeV2): Promise<ArtifactResolution> {
  return resolveArtifactForOperation('vision',context);
}
