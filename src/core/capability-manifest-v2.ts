import { z } from 'zod';
import type { Config } from '../config.js';
import { capabilityDomains } from './capability-domain.js';
import { adapterAvailable } from './policy-v2/arguments.js';
import { moduleEnabled, permitted, type Actor, type Chat } from './permissions.js';
import type { ToolMetadataV2 } from './tool-registry-v2.js';

export type CapabilityAvailability = 'AVAILABLE' | 'CONFIG_REQUIRED' | 'ADAPTER_UNAVAILABLE' | 'DISABLED' | 'PERMISSION_RESTRICTED';
export type ManifestContext = {
  actor: Actor; chat: Chat; config: Config;
  emergency?: boolean; maintenance?: boolean;
};
/** Advisory truth only. Policy revalidates identity, ownership, business state and effects. */
export function capabilityAvailability(tool: ToolMetadataV2, ctx: ManifestContext): CapabilityAvailability {
  if (!adapterAvailable(tool.name)) return 'ADAPTER_UNAVAILABLE';
  if (!permitted(ctx.actor, ctx.chat, tool.permission) || (tool.scope !== 'both' && (tool.scope === 'group') !== ctx.chat.isGroup)
    || (tool.name === 'memory.list' && ctx.chat.isGroup)) return 'PERMISSION_RESTRICTED';
  if ((ctx.emergency && tool.name !== 'control.reactivate') || (ctx.maintenance && ctx.actor.role !== 'owner')) return 'DISABLED';
  if (!moduleEnabled(ctx.chat, tool.requiredModule, ctx.config)) return 'DISABLED';
  if ((tool.requiredModule === 'minecraft' && !ctx.config.MINECRAFT_ENABLED)
    || (tool.requiredModule === 'drive' && !ctx.config.DRIVE_ENABLED)) return 'CONFIG_REQUIRED';
  if (['drive.search','drive.download','drive.upload'].includes(tool.name) && (ctx.chat.settings as Record<string, unknown>).drive !== true) return 'DISABLED';
  return 'AVAILABLE';
}

/** Finite operation choices, never argument schemas, bounds, examples or backend fields. */
function choices(tool: ToolMetadataV2, ctx: ManifestContext): string {
  const schema = z.toJSONSchema(tool.modelArgsSchema);
  return Object.entries(schema.properties ?? {}).flatMap(([field, value]) => {
    const entry = value as { enum?: unknown[] };
    if (!entry.enum) return [];
    return [`${field}=${entry.enum.map(option => `${String(option)}${tool.name === 'library.sync' && option === 'drive' && !ctx.config.LIBRARY_DRIVE_ENABLED ? '(CONFIG_REQUIRED)' : ''}`).join('/')}`];
  }).join(';');
}

/** Always complete, including unavailable/disabled/restricted tools; registry metadata is the only catalog. */
export function capabilityManifestV2(catalog: readonly ToolMetadataV2[], ctx: ManifestContext): string {
  const lines = [
    'Formato: capacidad: significado entrada→salida;estado. [dominio]: core.load_capability carga schemas faltantes. ∅=sin entrada; g=solo grupo. Policy revalida permisos/datos/resultados; disponibilidad no garantiza éxito externo.',
    'Estados: A=AVAILABLE; C=CONFIG_REQUIRED(falta configuración); U=ADAPTER_UNAVAILABLE(conexión pendiente); D=DISABLED(apagada); R=PERMISSION_RESTRICTED(rol/ámbito). No inventes operaciones o salidas ausentes.',
  ];
  for (const domain of capabilityDomains) {
    const tools = catalog.filter(t => t.domain === domain && t.llmVisible && t.exposure !== 'internal');
    if (!tools.length) continue;
    lines.push(`[${domain}]`);
    for (const tool of tools) {
      const c = tool.capability;
      if (!c?.summary?.trim() || !c.accepts?.trim() || !c.produces.trim()) throw new Error(`Missing manifest metadata: ${tool.name}`);
      const status = capabilityAvailability(tool, ctx);
      const permission = ['config.global','infra.minecraft','bulk.broadcast','bulk.nuclear','jobs.diagnose'].includes(tool.permission) ? 'owner'
        : ['chat.configure','school.manage','polls.manage','moderation.act'].includes(tool.permission) ? 'owner/admin' : '';
      const codes: Record<CapabilityAvailability, string> = {AVAILABLE:'A',CONFIG_REQUIRED:'C',ADAPTER_UNAVAILABLE:'U',DISABLED:'D',PERMISSION_RESTRICTED:'R'};
      lines.push(`${tool.name}: ${c.summary} ${c.accepts === 'sin entrada' ? '∅' : c.accepts}→${c.produces};${codes[status]}${tool.scope === 'both' ? '' : tool.scope === 'group' ? ',g' : ',privado'}${permission ? `,${permission}` : ''}${tool.confirmationPolicy === 'none' ? '' : ',confirmar'}`);
      if (c.operations) {
        for (const [name, op] of Object.entries(c.operations)) lines.push(` ${name}: ${op.description}; ${op.accepts} → ${op.produces}`);
      } else {
        const ops = choices(tool, ctx);
        if (ops) lines.push(` ${ops}`);
      }
    }
  }
  return lines.join('\n');
}

export function currentFunctionProtocolV2(names: readonly string[]): string {
  return `NATIVE FUNCTION PROTOCOL: Only these exact function names are callable NOW: ${names.join(', ')}. The manifest is knowledge, not a function declaration. For an AVAILABLE capability without a declared function, call core_load_capability FIRST with its domain and exact toolName to keep the needed schema within budget. Use native functionCall parts, NEVER JSON effects or written-out calls. If no real operation produces the requested output, return unavailable with the understood intention and actual limitation. effects must always be [].`;
}

export const capabilityBehaviorV2 = `PRIORIDAD DE COMPORTAMIENTO:
1. Comprende intención natural, typos, slang, contexto, ARTIFACT_STATE y activeSession conjuntamente con CURRENT_USER_TURN.
2. CAPABILITY_MANIFEST es el inventario exhaustivo de capacidades, operaciones y salidas; NO es la lista de funciones invocables. Busca la intención compatible. Si la salida pedida no existe, responde unavailable; comprender un formato no implica poder producirlo.
3. Invoca SOLO nombres exactos declarados en tools. Si la capacidad existe y está AVAILABLE pero su función no está declarada, DEBES llamar core_load_capability con su dominio ANTES de invocarla. Luego usa exclusivamente los argumentos/operaciones del schema cargado. No simules llamadas en effects ni inventes action/operation. No hay selección lexical en el backend.
4. Si existe pero está indisponible, explica la causa real: U significa que ESA función aún no está conectada; C falta configuración; D está apagada; R falta permiso/ámbito. No declares indisponibles otras funciones del dominio ni inventes un fallo del proveedor. No pidas datos que no resuelven la limitación ni finjas haber ejecutado.
5. Si no existe la operación o formato de salida, reconoce la intención inferida y explica que esa conversión/acción no está disponible. NUNCA ejecutes otra operación o formato como sustituto: una lectura/extracción no equivale a convertir al formato pedido. Ofrece una alternativa real como propuesta, sin tool ni efectos hasta que el usuario la pida.
6. Aclara únicamente una ambigüedad material restante. Usa los archivos CURRENT o REPLIED y la sesión para completar datos; no preguntes qué archivo si ya está identificado.
7. Aplica la personalidad después de resolver. NUNCA te burles de ortografía, typos, slang o mala escritura como sustituto de resolver; no corrijas su escritura. Si puedes inferir razonablemente la intención, ejecuta.
ARTIFACT_STATE contiene referencias opacas operativas: CURRENT enumera TODOS los adjuntos disponibles, REPLIED el citado, RECENT archivos recientes sin instrucciones históricas. UNRETAINED_CURRENT enumera adjuntos recibidos sin fuente retenida: no inventes refs ni uses un archivo antiguo como sustituto; explica que necesitas recibirlos disponibles, cuando no se hayan podido retener. A_LAST identifica el último archivo propio retenido; RECENT/A_LAST solo llevan metadata, usa core_load_artifact_context si necesitas ver una imagen anterior; el backend valida compatibilidad, vigencia y propiedad. Para múltiples fuentes usa artifactRefs de CURRENT/RECENT; media_collect coordina una colección cuando haga falta reunir archivos. Si activeSession de aclaración ya define la operación y falta la fuente, CURRENT compatible completa ese dato: DEBES invocar pendingTool con la operación preservada y el archivo actual; no responder como charla ni pedir de nuevo la fuente. Solo aclara otros datos realmente faltantes. No inventes referencias ni arrastres intención de un archivo antiguo. No muestres códigos de disponibilidad ni identificadores técnicos al usuario.`;
