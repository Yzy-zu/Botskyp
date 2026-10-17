import { DateTime } from 'luxon';
import { contextData } from './context-data-v2.js';

/** Final UX boundary. Preserve useful quantities, public URLs and local dates. */
export function sanitizeOutputV2(text: string): string {
  let safe = contextData(text)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu, value => {
      const date = DateTime.fromISO(value, { zone: 'America/Mexico_City' }).setLocale('es-MX');
      return date.isValid ? date.toFormat("d LLL yyyy, HH:mm 'CDMX'") : '[fecha no disponible]';
    })
    .replace(/\b(?:artifactRef|memberRef|noteRef|reminderRef|memoryRef|pollRef|taskRef|subjectRef|opRef|driveRef|destinationRef)_[a-f0-9-]+\b/giu, '')
    .replace(/\b(?:Trabajo|Resultado del trabajo)\s*#\d+[:.]?\s*/giu, '')
    .replace(/\b(?:nota|tarea|encuesta|materia|pedido|cooperacha|recordatorio)\s*#\d+/giu, word => word.replace(/\s*#\d+/u, ''))
    .replace(/^#\d+:?\s*/gmu, '')
    .replace(/\b(?:[A-Z][A-Z0-9]*_){1,}[A-Z0-9_]+\b/gu, '[configuración interna]')
    .replace(/\b(?:queued|processing|uncertain|pending_review)\b/giu, 'pendiente de confirmar')
    .replace(/\b(?:Gemini|SearXNG|redspi|PermissionKey|Policy Engine|backend|schema)\b/giu, 'el servicio')
    .replace(/\b(?:core|notes|memory|reminders|xp|games|polls|school|minecraft|media|library|packs|cooperacha|web|drive|bulk|messaging|control|diag)[._][a-z][a-z_-]*(?:\.[a-z_-]+)?\b/giu, 'esa función');
  // Internal objects are never a user response. They are not repaired by hiding individual keys.
  if (/"(?:actorId|chatId|toolName|permission|executionKey|confirmationId|confirmationHash|result_json|providerCallId|logicalActionId)"\s*:/u.test(safe) || /(?:confirmationHash|executionKey|logicalActionId|providerCallId|raw SQL|SELECT .+ FROM)/iu.test(safe)) {
    return 'No pude preparar una respuesta clara. No voy a confirmar una operación sin comprobar su resultado.';
  }
  safe = safe.replace(/\[(?:identidad|identificador|ruta)\]/gu, '').replace(/[ \t]+\n/gu, '\n').trim();
  return safe;
}
