import { z } from 'zod';
import type { ToolResult } from './tool-result.js';
import { sanitizeOutputV2 } from './output-sanitizer-v2.js';
import { formatHumanDue } from '../modules/reminders/semantic-time.js';
import { mediaFailure } from '../modules/media/messages.js';

const moduleNames: Record<string, string> = { games:'juegos', school:'escuela', library:'biblioteca', media:'archivos', memory:'memoria', notes:'notas', polls:'encuestas', web:'búsqueda web', economy:'XP', productivity:'notas y recordatorios', minecraft:'Minecraft', drive:'Drive' };
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function localPresenterV2(result: ToolResult): string {
  const data=record(result.data), name=result.toolName, code=result.code;
  if (result.status === 'denied') {
    if(code==='DENIED_PERMISSION')return /^(?:minecraft\.|bulk\.|control\.|diag\.)/u.test(name)?'Esa función solo la puede usar el dueño del bot.':'Eso solo lo pueden hacer los admins del grupo.';
    if(code==='DENIED_MODULE_DISABLED' || code==='DENIED_DRIVE_DISABLED')return `El módulo de ${moduleNames[name.split('.')[0]!] ?? moduleNames[result.domain] ?? 'esa función'} está apagado en este chat.`;
    if(code==='DENIED_ADAPTER_UNAVAILABLE')return 'Esa parte todavía no la tengo conectada.';
    if(code==='DENIED_INSUFFICIENT_XP')return typeof data.balance==='number' && typeof data.shortfall==='number'?`Te faltan ${data.shortfall} XP para eso; tienes ${data.balance}.`:'No tienes suficientes XP para eso.';
    if(code==='DENIED_SOURCE_MESSAGE_CONFLICT')return 'Solo puedo tramitar una acción de ese tipo por mensaje. Pídeme la otra en un mensaje nuevo.';
    if(code==='DENIED_MEDIA_TURN_LIMIT')return 'Solo puedo preparar un archivo por mensaje. Pídeme el siguiente paso cuando termine este.';
    if(code==='DENIED_DAILY_COOLDOWN')return 'Ya cobraste tu premio diario. Vuelve cuando se cumplan las 24 horas.';
    if(code==='DENIED_PRIVATE_ONLY')return 'Pídemelo por privado para cuidar tu información.';
    if(code==='DENIED_SENSITIVE_MEMORY')return 'No guardo contraseñas, tokens ni datos sensibles.';
    if(code==='DENIED_MAINTENANCE')return 'Estoy en mantenimiento. Inténtalo más tarde.';
    if(code==='DENIED_EMERGENCY')return 'Estoy apagado por emergencia. El dueño tiene que reactivarme.';
    if(code==='DENIED_IDENTITY_UNRESOLVED')return 'No pude verificar quién envió la solicitud. Inténtalo de nuevo.';
    if(code==='DENIED_OWNERSHIP')return 'Solo puedes cambiar tus propios datos o archivos.';
    if(code.startsWith('DENIED_CONFIRMATION'))return 'La confirmación venció o cambió la operación. Pídemela otra vez para revisarla.';
    if(code==='DENIED_POLL_CLOSED')return 'Esa encuesta ya está cerrada.';
    if(code.includes('NOT_FOUND'))return 'No encontré una operación activa para eso en este chat.';
    if(code.startsWith('INVALID'))return 'Me faltan datos válidos para hacerlo. No hice cambios.';
    return 'No pude completar esa solicitud. No hice cambios.';
  }
  if(result.status==='needs_confirmation')return typeof data.prompt==='string'?data.prompt:'¿Seguro que quieres hacerlo? Dime “sí” o “nel”.';
  if(result.status==='needs_clarification'){
    if(/AMBIGUOUS_HOUR/u.test(code))return '¿De la mañana o de la noche?';
    if(code==='MISSING_BODY')return '¿Qué quieres que te recuerde?';
    if(code==='MISSING_TIME')return '¿Cuándo quieres que te lo recuerde?';
    if(code==='MISSING_DATE')return '¿Para hoy o mañana?';
    return 'Me falta un dato para hacerlo. ¿Puedes precisarlo?';
  }
  if(result.status==='not_found')return result.domain==='media'?'No tengo ese archivo disponible en este chat. Reenvíalo con la solicitud.':'No encontré eso en este chat. ¿Cuál quieres usar?';
  if(result.status==='uncertain')return 'La solicitud quedó pendiente de confirmar. No voy a repetirla automáticamente.';
  if(result.status==='error')return result.presentation || 'No pude completar esa operación. No confirmo ningún cambio.';
  if(result.status==='queued'){
    if(name==='media.process' || name==='media.collect')return '';
    if(name.startsWith('minecraft.'))return 'Ya solicité la operación de Minecraft. Todavía no está confirmado el cambio.';
    return 'La solicitud está en marcha. Te aviso cuando tenga el resultado.';
  }
  if(name==='xp.balance' || name==='xp.daily')return `${name==='xp.daily'?'Listo, cobraste tu premio diario. ':''}Tienes ${data.balance} XP. Nivel ${data.level}; racha de ${data.streak}.`;
  if(name==='media.status')return Array.isArray(data.jobs) && data.jobs.length?data.jobs.map(item=>{
    const job=record(item),label=job.operation==='office_pdf'?'La conversión a PDF':job.operation==='images_pdf'?'El PDF de tus fotos':job.operation==='pdf_merge'?'La unión de tus PDF':'El procesamiento del archivo';
    if(job.status==='failed')return `${label} falló y por eso no te llegó el archivo.${typeof job.error==='string'?` ${/timeout/u.test(job.error)?'La conversión tardó demasiado y no alcanzó a generar el archivo.':mediaFailure(job.error)}`:''}`;
    if(job.status==='done')return job.delivery==='sent'?`${label} terminó y el envío está confirmado en este chat.`:job.delivery==='uncertain'?`${label} terminó, pero no pude confirmar la entrega. No voy a repetir el envío automáticamente.`:job.delivery==='failed'?`${label} terminó, pero falló el envío.`:`${label} terminó; el envío sigue pendiente.`;
    return job.status==='running'?`${label} sigue en marcha.`:`${label} está esperando su turno.`;
  }).join('\n'):'No encontré una operación reciente tuya para ese archivo en este chat.';
  if(name==='core.help')return 'Pídeme lo que necesites: guardar un recuerdo, anotar algo para el grupo, crear un recordatorio, consultar tus XP, jugar, buscar información o trabajar con un archivo. Te diré qué está disponible aquí.';
  if(name==='reminders.create')return `Listo, te recordaré «${String(data.body)}» el ${formatHumanDue(new Date(String(data.dueAt)))}.`;
  if(name==='reminders.edit')return `Listo, cambié tu recordatorio de «${String(data.body)}» al ${formatHumanDue(new Date(String(data.dueAt)))}.`;
  if(name.startsWith('games.') && typeof data.hand==='string')return `Blackjack: ${data.hand} (${data.total}). Apuesta: ${data.bet} XP.\nDealer: ${data.dealer}.${data.closed?` Partida terminada.${typeof data.returnedXp==='number'?` Recibiste ${data.returnedXp} XP.`:''}`:' ¿Otra carta o te plantas?'}`;
  if(name==='memory.remember')return 'Listo, lo guardé en tu memoria personal.';
  if(name==='notes.create')return `Listo, anoté «${String(data.body ?? 'eso')}» para este chat.`;
  if(name==='notes.edit')return 'Listo, actualicé la nota.';
  if(name==='notes.delete')return 'Listo, borré esa nota.';
  if(name==='reminders.cancel')return 'Listo, cancelé ese recordatorio.';
  if(name==='polls.vote')return `Va, tu voto quedó registrado${typeof data.label==='string'?` por ${data.label}`:''}.`;
  if(name==='notes.list' || name==='memory.list'){
    const items=(name==='notes.list'?data.notes:data.memories);
    return Array.isArray(items) && items.length?items.map(item=>String(record(item).body ?? '')).filter(Boolean).join('\n'):name==='memory.list'?'No tengo recuerdos tuyos.':'No hay notas para esa búsqueda.';
  }
  if(name==='reminders.list' && Array.isArray(data.reminders))return data.reminders.map(item=>{const r=record(item);return `${String(r.body)} — ${formatHumanDue(new Date(String(r.due_at)))}`;}).join('\n') || 'No tienes recordatorios pendientes.';
  if(name==='web.search'){
    const sources=Array.isArray(data.searchResults)?data.searchResults.map(record).filter(r=>typeof r.snippet==='string' && r.snippet.trim()).slice(0,2):[];
    return sources.length?`No pude completar la explicación, pero encontré esto:\n${sources.map(r=>`${String(r.snippet).slice(0,600)}${typeof r.url==='string' && /^https?:\/\//u.test(r.url)?`\nFuente: ${r.url}`:''}`).join('\n\n')}`:'Encontré información, pero no pude preparar una respuesta verificada con esos resultados. Inténtalo más tarde.';
  }
  return result.presentation || 'La consulta terminó, pero no tengo más detalles disponibles.';
}

/** Explicit allowlist projection. Neither DB keys nor local exceptions reach the provider. */
export function visibleToolResultV2(result: ToolResult): Record<string, unknown> {
  const allowed=new Set(['balance','level','streak','label','option','question','options','votes','closed','body','notes','memories','reminders','due_at','timezone','status','searchResults','total','goal','count','shortfall','title','snippet','url','hand','bet','dealer','returnedXp','dueAt','open']);
  function project(value: unknown): unknown {
    if(Array.isArray(value))return value.slice(0,30).map(project);
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>allowed.has(key)).map(([key,v])=>[key,project(v)]));
    return typeof value==='string'?sanitizeOutputV2(value):value;
  }
  return {status:result.status,message:sanitizeOutputV2(localPresenterV2(result)),data:project(result.data)};
}

export const conversationalOutcomeV2=z.strictObject({
  outcome:z.enum(['conversation','action_required','unavailable']),
  text:z.string().min(1).max(12000),
  effects:z.array(z.strictObject({action:z.string(),status:z.enum(['ok','queued'])})).max(3),
});
/** Plain provider prose has no authority. Local mutation templates always come from current receipts. */
export function conversationTextV2(text: string): { text: string; retry: boolean; valid?: boolean } {
  // Secondary diagnostic for a provider violating its structured no-effects declaration.
  const mutationClaim=/(?<![\p{L}\p{N}_])(?:voto registrad[oa]|listo[,.:!]?\s+(?:guardad[oa]|registrad[oa])|(?:te )?di \d+\s*XP|recordatorio creado|mensaje enviado|ya (?:guardé|envié|creé|borré|cancelé|registré|programé|anoté|actualicé|otorgué|te di|quedó))(?![\p{L}\p{N}_])/iu;
  const noAction={text:'No ejecuté ninguna acción para esa solicitud.',retry:false};
  const invalid={text:'No pude preparar una respuesta clara. Inténtalo otra vez.',retry:false};
  let value: unknown;
  const json=text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu,'$1');
  try { value=JSON.parse(json); } catch { return mutationClaim.test(text)?noAction:invalid; }
  const parsed=conversationalOutcomeV2.safeParse(value);
  if(!parsed.success && record(value).outcome==='action_required')return {...noAction,retry:true};
  if(!parsed.success)return mutationClaim.test(text)?noAction:invalid;
  if(parsed.data.effects.length)return noAction;
  if(parsed.data.outcome==='action_required')return {...noAction,retry:true};
  if(mutationClaim.test(parsed.data.text))return noAction;
  return {text:parsed.data.text,retry:false,valid:true};
}
