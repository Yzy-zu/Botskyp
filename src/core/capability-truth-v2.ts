import type { ToolExposure } from './tool-exposure.js';
import type { ToolMetadataV2 } from './tool-registry-v2.js';
import type { ToolCtx } from './tools.js';
import type { TurnContextV2 } from './context-v2.js';
import { capabilityAvailability } from './capability-manifest-v2.js';
export function capabilityContextV2(exposure: ToolExposure): string {
  return `Schemas cargados: ${exposure.selectedDomains.join(', ')}. CAPABILITY_MANIFEST es el catálogo completo; core_load_capability carga el dominio que falte. Cumple la utilidad antes del humor.`;
}

export type CapabilityClaimV2={toolName:string;operation?:string|undefined;outputFormat?:string|undefined};
/** Only structured model claims and registry facts; never current text or model prose. */
export async function verifiedLimitationV2(ctx:ToolCtx,context:TurnContextV2,catalog:readonly ToolMetadataV2[],claim?:CapabilityClaimV2):Promise<boolean>{
  if(!claim)return false;
  const tool=catalog.find(t=>t.name===claim.toolName && t.llmVisible);
  if(!tool)return true;
  const flags=(await ctx.c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags')).rows;
  if(capabilityAvailability(tool,{actor:context.runtime.actor,chat:context.runtime.chat,config:ctx.config,emergency:flags.some(f=>f.key==='emergency' && f.value===true),maintenance:flags.some(f=>f.key==='maintenance' && f.value===true)})!=='AVAILABLE')return true;
  const operations=tool.capability?.operations;
  if(claim.operation && operations && !Object.hasOwn(operations,claim.operation))return true;
  if(claim.outputFormat && operations){
    const outputs=Object.values(operations).flatMap(op=>op.produces.split('/'));
    return !outputs.includes(claim.outputFormat);
  }
  return false;
}
