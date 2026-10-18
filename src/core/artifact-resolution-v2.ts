import type { PoolClient } from 'pg';
import { product } from '../../config/product.js';
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
/** Current/reply are explicit: incompatible input cannot silently select another file. */
export async function resolveArtifactForOperation(operation: ArtifactOperation, context: ArtifactScopeV2, explicitRef?: string): Promise<ArtifactResolution> {
  const candidates = await artifactsForTurn(context.c, {...context,resolveTextResultSource:true});
  for (const [ref, files] of [['A_CURRENT', candidates.current], ['A_REPLY', candidates.reply]] as const) {
    if (files.length) {
      const compatible = files.filter(a => artifactCompatible(operation, a));
      return compatible.length === 1 ? { status: 'ok', artifact: compatible[0]!, ref }
        : { status: compatible.length ? 'needs_clarification' : 'incompatible' };
    }
    if (explicitRef === ref) return { status: 'not_found' };
  }
  if (context.quotedMessageId && (!explicitRef || explicitRef === 'A_REPLY')) return { status: 'not_found' };
  if (explicitRef && explicitRef !== 'A_LAST') {
    const resolved = context.safeRefMap.resolve(explicitRef, 'artifactRef', context);
    if (resolved.status !== 'ok') return { status: resolved.status };
    const artifact = (await context.c.query<ArtifactRecord>(`SELECT a.* FROM chat_artifacts a
      LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
      WHERE a.id=$1 AND a.chat_id=$2 AND a.actor_id=$3 AND a.expires_at>$4
        AND ((m.data IS NOT NULL AND m.expires_at>$4) OR (s.data IS NOT NULL AND s.expires_at>$4))`, [resolved.id, context.chatId, context.actorId, context.now])).rows[0];
    return !artifact ? { status: 'not_found' } : artifactCompatible(operation, artifact) ? { status: 'ok', artifact, ref: explicitRef } : { status: 'incompatible' };
  }
  // Search by MIME compatibility in SQL, rather than hiding the last PDF behind five newer DOCX files.
  const mimes = operation === 'resend' ? null : operation === 'vision'
    ? Object.keys(extensions).filter(mime => mime.startsWith('image/'))
    : Object.keys(extensions).filter(mime => artifactCompatible(operation, { mime }));
  const artifact = (await context.c.query<ArtifactRecord>(`SELECT a.* FROM chat_artifacts a
    LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
    WHERE a.chat_id=$1 AND a.actor_id=$2 AND a.expires_at>$3 AND a.created_at>=$3::timestamptz-$4::bigint*interval '1 millisecond'
      AND ($5::text[] IS NULL OR a.mime=ANY($5))
      AND ((m.data IS NOT NULL AND m.expires_at>$3) OR (s.data IS NOT NULL AND s.expires_at>$3))
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [context.chatId, context.actorId, context.now,
    operation === 'vision' ? product.recentImageMinutes * 60_000 : product.artifactWindowMs, mimes])).rows[0];
  return artifact ? { status: 'ok', artifact, ref: 'A_LAST' } : { status: 'not_found' };
}

/** Vision looks for an image, independent of wording and unrelated attachment types. */
export async function resolveVisionArtifactV2(context: ArtifactScopeV2): Promise<ArtifactResolution> {
  const files = await artifactsForTurn(context.c, context);
  for (const [ref, candidates] of [['A_CURRENT',files.current],['A_REPLY',files.reply]] as const) {
    const images = candidates.filter(a => artifactCompatible('vision',a));
    if (images.length) return images.length === 1 ? { status:'ok',artifact:images[0]!,ref } : { status:'needs_clarification' };
    if (candidates.length) return { status:'not_found' };
  }
  if(context.quotedMessageId || context.allowRecentVision===false)return {status:'not_found'};
  return resolveArtifactForOperation('vision', { c: context.c, chatId: context.chatId, actorId: context.actorId, sourceMessageId: '', now: context.now, safeRefMap: context.safeRefMap });
}
