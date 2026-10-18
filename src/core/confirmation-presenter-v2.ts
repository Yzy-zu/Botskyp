import { formatSchedule, scheduleSchema } from '../modules/school/schemas.js';
import { product } from '../../config/product.js';
import { sanitizeOutputV2 } from './output-sanitizer-v2.js';
import type { ExecutionContextV2, PolicyDecision } from './policy-v2/types.js';

export async function confirmationPromptV2(ctx:ExecutionContextV2,name:string,decision:PolicyDecision):Promise<string>{
  const args=decision.resolvedArgs;
  if(name==='school.schedule_propose'){
    const proposal=scheduleSchema.parse(args);
    return sanitizeOutputV2(`Propuesta de horario semanal:\n${formatSchedule(proposal)}\nReemplaza el horario completo; conserva tareas y materias. ¿Confirmas esta propuesta?`);
  }
  if(name==='minecraft.restart')return '¿Seguro que reinicio el servidor de Minecraft? Dime “sí” o “nel”.';
  if(name==='minecraft.stop')return '¿Seguro que apago el servidor de Minecraft? Dime “sí” o “nel”.';
  if(name==='bulk.nuclear')return sanitizeOutputV2(`Va. Serían ${args.count ?? product.nuclearMessages} mensajes en este grupo diciendo «${String(args.text)}». ¿Le doy? Dime “sí” o “nel”.`);
  if(name==='notes.delete'){
    const note=(await ctx.legacy.c.query<{body:string}>('SELECT body FROM notes WHERE id=$1 AND chat_id=$2',[args.id,ctx.chatId])).rows[0];
    return sanitizeOutputV2(`¿Seguro que quieres borrar la nota «${note?.body ?? 'esa nota'}»? Dime “sí” o “nel”.`);
  }
  if(name==='memory.forget')return '¿Seguro que quieres borrar esos recuerdos de tu memoria personal? Dime “sí” o “nel”.';
  if(name==='messaging.send' || name==='bulk.broadcast')return sanitizeOutputV2(`Voy a enviar «${String(args.text)}» a ${Array.isArray(args.destinations)?args.destinations.length:1} destino(s) autorizado(s). ¿Le doy? Dime “sí” o “nel”.`);
  return '¿Seguro que quieres realizar esa operación? Dime “sí” o “nel”.';
}
