import { z } from 'zod';
import { product } from '../../config/product.js';
import type { PermissionKey } from './permissions.js';
import type { ToolRegistry, CapabilityMetadata } from './tools.js';
import type { Declaration } from './llm.js';
import type { CapabilityDomain } from './capability-domain.js';
import { modelArgsSchemas, type BusinessToolName } from './model-args.js';

export type ToolRisk = 'READ' | 'USER_WRITE' | 'ECONOMIC' | 'EXTERNAL' | 'PRIVILEGED' | 'DESTRUCTIVE';
export type ConfirmationPolicy = 'none' | 'explicit' | 'preview';
export interface ToolMetadataV2 {
  readonly name: BusinessToolName;
  readonly domain: CapabilityDomain;
  readonly descriptionForModel: string;
  readonly risk: ToolRisk;
  readonly llmVisible: boolean;
  readonly exposure: 'always' | `dynamic:${CapabilityDomain}` | 'internal';
  readonly permission: PermissionKey;
  readonly requiredModule: string;
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly modelArgsSchema: z.ZodType;
  readonly backendOnlyFields: readonly string[];
  readonly presenter: 'canonical' | 'job_status' | 'preview';
  readonly requiresResultBeforeReply: boolean;
  readonly supportsImmediateExecution: boolean;
  readonly idempotencyStrategy: 'read_only' | 'execution_ledger' | 'durable_job' | 'confirmed_action';
  readonly scope: 'group' | 'private' | 'both';
  readonly capability?: CapabilityMetadata;
  readonly hiddenReason?: string;
}

export const alwaysOnBusinessTools = [
  'core.help', 'notes.create', 'reminders.create', 'memory.remember',
  'web.search', 'xp.balance', 'xp.daily',
] as const satisfies readonly BusinessToolName[];
const internal: Partial<Record<BusinessToolName, string>> = {
  'school.schedule_commit': 'Commit de preview autenticado; solo continuación de confirmación.',
  'bulk.confirm': 'Confirmación vinculada a preview/hash; solo backend de SessionV2.',
};
const moduleDomains: Record<string, CapabilityDomain> = {
  core: 'core', notes: 'productivity', reminders: 'productivity', memory: 'productivity',
  web: 'web', xp: 'economy', polls: 'polls', school: 'school', games: 'games', media: 'media',
  library: 'library', moderation: 'moderation', minecraft: 'minecraft', drive: 'drive', messaging: 'messaging',
  video: 'media',
};
// Risks describe effects, never authorization. PermissionKey is copied unchanged from v1.
const economic = new Set<string>(['xp.daily','xp.happy','packs.buy','cooperacha.open','cooperacha.contribute','cooperacha.cancel','games.blackjack','games.roulette','games.join','games.play','games.cancel','games.airdrop','games.claim']);
const external = new Set<string>(['web.search','drive.search','drive.download','drive.upload','media.search','media.process','media.collect','school.task_attachment','video.search','video.info','video.download']);
const privileged = new Set<string>(['control.emergency','control.reactivate','control.maintenance_on','control.maintenance_off','control.modules','library.sync','library.rain','moderation.change','moderation.config','drive.configure','school.subject_save','school.schedule_propose','school.schedule_import','school.schedule_commit','school.summary_configure','school.destination','messaging.send','bulk.broadcast','bulk.nuclear','bulk.cancel','bulk.retry','bulk.resume']);
const preview = new Set<string>(['school.schedule_propose','school.schedule_commit','messaging.send','bulk.broadcast','bulk.nuclear','bulk.confirm']);
const jobs = new Set<string>(['library.sync','drive.search','drive.download','drive.upload','media.process','media.collect','packs.buy','school.task_attachment','messaging.send','bulk.broadcast','bulk.nuclear','bulk.retry','bulk.resume','video.download']);
export const backendOnlyFields = [
  'actorId','chatId','jid','senderId','ownerId','targetGroupId','id','importId','hash','previewHash',
  'confirmationHash','path','filePath','role','roles','dueAt','timezone','sourceMessageId',
] as const;
const descriptions: Partial<Record<BusinessToolName, string>> = {
  'notes.create': 'Crear una nota compartida del chat por petición explícita de nota. Conserva literal el contenido solicitado; no lo estilices. Guardar memoria personal corresponde a memory.remember.',
  'notes.list': 'Consultar notas del chat. Para listar todas omite query; úsalo solo si el usuario pidió buscar un tema concreto, nunca la palabra genérica notas.',
  'media.process': 'Procesar las fuentes ya disponibles: images_pdf genera un PDF con TODAS las imágenes elegidas en artifactRefs; pdf_merge une los PDF elegidos. No necesita abrir una colección. Crear o procesar archivos SOLO si una operación del schema produce exactamente la salida solicitada. Si el formato o conversión pedido no existe, explica la limitación SIN ejecutar una lectura/extracción u otra conversión alternativa; solo puedes ofrecerla. Para crear un código QR llama esta función con operation=qr_create y text con el contenido exacto, sin artifactRef. Para generar un audio o nota de voz con operation=speak: si el usuario pide decir o grabar algo sobre un tema, motivo o intención, redacta naturalmente el contenido a pronunciar en text con la personalidad de Botsky y llama la función directamente; solo pide aclaración si no hay ningún tema o contenido indicado. Para leer QR usa qr_read y el archivo. Para sticker usa sticker. No presentes archivos como creados antes del resultado del worker.',
  'media.collect': 'GESTIÓN DE SESIÓN: start espera archivos futuros, no genera un PDF; finish procesa una colección ya abierta. Si ya están todas las fuentes en CURRENT y el usuario pide el PDF ahora, usa media.process con artifactRefs; esta tool es para reunir más archivos en una colección. Reunir fotos en un PDF (images_pdf) o unir varios PDF (pdf_merge). action=start inicia o conserva la colección. Si hay una colección abierta y el usuario dice con esas hazlo, ya están todas, listo o cualquier petición equivalente de finalizar, usa action=finish con la operación de activeSession.collection; nunca vuelvas a start para finalizar. Los archivos los resuelve el programa. No afirmes entrega antes del resultado del worker.',
  'video.search': 'Buscar videos en internet (Dailymotion, web, etc.). Devuelve lista numerada de resultados con videoRef para descargar o consultar.',
  'video.info': 'Consultar información detallada y metadatos de un video de la búsqueda activa mediante su videoRef.',
  'video.download': 'Descargar un video o audio de la búsqueda activa mediante su videoRef. Se procesa en cola de forma asíncrona.',
  'notes.edit': 'Editar o corregir una nota existente del chat por su noteRef en REFERENCE_DATA.notes.',
  'memory.remember': 'Guardar memoria personal solo por petición explícita: guarda en tu memoria, acuérdate de que o recuerda que. Una petición de aviso a una hora futura corresponde a reminders.create. Nunca crear una nota compartida para esa petición.',
  'memory.forget': 'Borrar una memoria personal por referencia o contenido, o todas (all), con confirmación.',
  'reminders.create': 'Crear un recordatorio personal o aviso futuro. Conserva literal el contenido solicitado; no lo estilices. Una petición de aviso futuro a una hora determinada es un recordatorio, no memoria personal. Si el usuario dio la hora pero NO la fecha o día, usa time.kind="clock" con hour y meridiem (si indicó mañana/tarde/noche/am/pm). Si no indicó am/pm para horas 1-12, omite meridiem. Si hay activeSession de aclaración para reminders.create, conserva los datos de activeSession.partialArgs no modificados y actualiza lo que el usuario respondió o corrigió.',
  'reminders.edit': 'Editar un recordatorio propio. Omite body si no cambia el texto. Si solo cambia la hora del mismo día, usa kind=date con la fecha de dueLocal del recordatorio, nunca supongas today. El backend conserva campos omitidos.',
  'games.blackjack': `Jugar blackjack con la apuesta exacta solicitada. Mínimo ${product.gameMinBet} XP: si pide menos, explica el mínimo y pregunta cuánto quiere apostar; nunca aumentes su apuesta ni ejecutes el mínimo automáticamente.`,
  'games.roulette': `Jugar ruleta con la apuesta exacta solicitada. Mínimo ${product.gameMinBet} XP; si pide menos, explica el mínimo, sin aumentar ni ejecutar otra apuesta.`,
  'school.task_create': 'Registrar una tarea del miembro autenticado en una materia existente. time solo si se dio fecha explícita; sin time el backend usa próxima clase o sin fecha. includeAttachment selecciona un adjunto confiable.',
  'school.task_edit': 'Editar título o fecha de una tarea propia por referencia. Owner/admin pueden editar otras del grupo; el backend valida propiedad. time=null quita la fecha.',
  'school.schedule_import': 'Leer la imagen de horario seleccionada por artifactRef y extraer lessons. Esta lectura NO guarda nada: tras su functionResponse llama school.schedule_propose con las lessons extraídas para mostrar el preview completo y solicitar confirmación.',
  'school.destination': 'Configurar destino escolar autorizado por referencia; restringido a owner/admin.',
  'minecraft.status': 'Consultar estado del servidor Minecraft.',
  'minecraft.players': 'Consultar quién está jugando en el servidor configurado: hay alguien en el maicra, quién anda en el server.',
  'xp.daily': 'Cobrar el premio diario propio: daily, premio de hoy, recompensa, giro gratis de hoy. No es una apuesta ni ruleta. Un giro sin contexto puede necesitar aclaración.',
  'xp.balance': 'Consultar XP, puntos o saldo propios: cuánta XP traigo, cuántos puntos tengo, ando pobre o qué.',
};

/** Read-only metadata catalog: deliberately exposes no business run/execute method. */
export function createToolRegistryV2(legacy: ToolRegistry): readonly ToolMetadataV2[] {
  const tools = legacy.all();
  if (tools.length !== Object.keys(modelArgsSchemas).length) throw new Error('v2 catalog differs from business registry');
  return Object.freeze(tools.map(tool => {
    if (!Object.hasOwn(modelArgsSchemas, tool.name)) throw new Error('Missing v2 tool metadata');
    const name = tool.name as BusinessToolName;
    if (!internal[name] && (!tool.description.trim() || !tool.capability?.produces.trim())) throw new Error(`Missing public capability metadata: ${name}`);
    const schema = z.toJSONSchema(modelArgsSchemas[name]);
    const capability = tool.capability ? Object.freeze({
      ...tool.capability,
      summary: tool.capability.summary ?? tool.description,
      accepts: tool.capability.accepts ?? (Object.keys(schema.properties ?? {}).join(',') || 'sin entrada'),
    }) : undefined;
    const domain = name.startsWith('control.') || name.startsWith('diag.') ? 'admin' : moduleDomains[tool.module];
    if (!domain) throw new Error('Missing capability domain');
    const risk: ToolRisk = tool.risk === 'destructive' ? 'DESTRUCTIVE'
      : economic.has(name) ? 'ECONOMIC'
      : privileged.has(name) || (domain === 'minecraft' && tool.risk !== 'read') ? 'PRIVILEGED'
      : external.has(name) ? 'EXTERNAL' : tool.risk === 'read' ? 'READ' : 'USER_WRITE';
    const confirmationPolicy: ConfirmationPolicy = preview.has(name) ? 'preview' : risk === 'DESTRUCTIVE' ? 'explicit' : 'none';
    const isJob = jobs.has(name) || (domain === 'minecraft' && tool.risk !== 'read');
    return Object.freeze({
      name, domain, descriptionForModel: descriptions[name] ?? tool.description,
      risk, llmVisible: !internal[name],
      exposure: internal[name] ? 'internal' : (alwaysOnBusinessTools as readonly string[]).includes(name) ? 'always' : `dynamic:${domain}`,
      ...(internal[name] ? { hiddenReason: internal[name] } : capability ? { capability } : {}),
      permission: tool.permission, requiredModule: tool.module, confirmationPolicy,
      modelArgsSchema: modelArgsSchemas[name], backendOnlyFields,
      presenter: confirmationPolicy === 'preview' ? 'preview' : isJob ? 'job_status' : 'canonical',
      requiresResultBeforeReply: true,
      supportsImmediateExecution: confirmationPolicy === 'none' && !isJob && ['READ','USER_WRITE'].includes(risk),
      idempotencyStrategy: confirmationPolicy !== 'none' ? 'confirmed_action' : isJob ? 'durable_job' : risk === 'READ' ? 'read_only' : 'execution_ledger',
      scope: tool.scope,
    } satisfies ToolMetadataV2);
  }));
}

/** Fail closed on backend field leaks, including nested fields. No schema is derived from handler args. */
export function modelDeclaration(tool: Pick<ToolMetadataV2, 'name' | 'descriptionForModel' | 'modelArgsSchema' | 'backendOnlyFields' | 'permission' | 'risk' | 'llmVisible' | 'exposure'>): Declaration {
  if (!tool.llmVisible || tool.exposure === 'internal') throw new Error('Internal tool cannot be exposed');
  const schema = z.toJSONSchema(tool.modelArgsSchema);
  delete schema.$schema;
  if(tool.name==='memory.remember'){
    // Expose one canonical field; Policy still accepts the historical fact alias.
    delete schema.properties?.fact;
    schema.required=['body'];
  }
  const forbidden = new Set(tool.backendOnlyFields.map(field => field.toLowerCase()));
  function inspect(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(inspect); return; }
    const entry = node as Record<string, unknown>;
    if (entry.properties && typeof entry.properties === 'object') {
      for (const field of Object.keys(entry.properties)) {
        if (forbidden.has(field.toLowerCase()) || /(?:jid|(?:actor|chat|owner|user|raw|db).*id|path|role|hash)$/iu.test(field)) throw new Error('Backend-only model field');
      }
    }
    Object.values(entry).forEach(inspect);
  }
  inspect(schema);
  return {
    name: tool.name.replaceAll('.', '_').replaceAll('-', '_'),
    description: `${tool.descriptionForModel} [permission=${tool.permission}; risk=${tool.risk}; autorización y propiedad siempre las valida el backend]`,
    parametersJsonSchema: schema,
  };
}

export function registryV2Declarations(catalog: readonly ToolMetadataV2[]): Declaration[] {
  return catalog.filter(tool => tool.llmVisible && tool.exposure !== 'internal').map(modelDeclaration);
}
