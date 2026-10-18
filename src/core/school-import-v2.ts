import { extractSchedule } from '../modules/school/schedule.js';
import { storedMediaSchema } from '../modules/school/attachments.js';
import { moduleEnabled } from './permissions.js';
import { ok,fail } from './tools.js';
import type { ExecutionContextV2, PolicyDecision } from './policy-v2/types.js';

/** Import reads the exact selected backing; Gemini then proposes these lessons for a full preview. */
export async function runSchoolImportV2(ctx:ExecutionContextV2,decision:PolicyDecision){
  if(!moduleEnabled(ctx.chat,'vision',ctx.legacy.config))return fail('La visión está desactivada en este chat.');
  const ref=decision.resolvedSafeRefs.find(r=>r.kind==='artifactRef');
  if(!ref)return fail('Selecciona una imagen del horario.');
  const row=(await ctx.legacy.c.query<{data:Buffer;mime:string}>(`SELECT coalesce(m.data,s.data) data,a.mime FROM chat_artifacts a
    LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
    WHERE a.id=$1 AND a.chat_id=$2 AND a.actor_id=$3 AND a.expires_at>clock_timestamp()
      AND ((m.data IS NOT NULL AND m.expires_at>clock_timestamp()) OR (s.data IS NOT NULL AND s.expires_at>clock_timestamp()))`,[ref.id,ctx.chatId,ctx.actorId])).rows[0];
  if(!row || !row.mime.startsWith('image/'))return fail('La imagen del horario ya no está disponible.');
  const media=storedMediaSchema.safeParse({kind:'image',mime:row.mime,base64:row.data.toString('base64')});
  if(!media.success)return fail('Ese formato de imagen no está disponible para el horario.');
  const proposal=await extractSchedule(ctx.legacy,media.data);
  return proposal?ok('Extraje una propuesta. Falta mostrar y confirmar el horario antes de guardarlo.',proposal):fail('No pude extraer un horario completo y claro. Envía una foto más legible.');
}
