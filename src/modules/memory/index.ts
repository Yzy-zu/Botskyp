import { z } from 'zod';
import { defineTool,ok,fail,type Tool } from '../../core/tools.js';
import { product } from '../../../config/product.js';
/** Deliberately conservative: never persist likely credentials or financial/health identifiers. */
export function sensitiveMemory(text:string):boolean{
  return /contrase[ñn]a|password|passphrase|token|api[ _-]?key|clave|secreto|secret|tarjeta|card\b|cvv|nip\b|pin\b|curp|rfc\b|domicilio|direcci[oó]n|diagn[oó]stico|enfermedad|cuenta bancaria|clabe|[A-Za-z0-9_\-/+=]{28,}|(?:\d[ -]?){13,19}|-----BEGIN|AIza|sk-[a-z0-9]/iu.test(text);
}
export function explicitMemoryRequest(text:string):boolean{
  return /(?:acu[eé]rdate|recuerda|guarda en (?:tu )?memoria|memoriza)\s+(?:de\s+)?(?:que\s+)?/iu.test(text);
}
const base={capability:{produces:'memoria'},module:'memory',permission:'chat.use',scope:'both',modelCallable:false} as const;
export const memoryTools:Tool[]=[
  defineTool({...base,name:'memory.remember',capability:{summary:'Recordar dato personal explícito.',produces:'recibo'},description:'Guardar memoria personal solo por petición explícita.',examples:['bot acuérdate de que me gusta el ajedrez'],risk:'write',args:z.strictObject({body:z.string().trim().min(1).max(product.memoryChars)}),
    async run(ctx,args){if(ctx.config.ROUTER_MODE!=='v1_1' && !explicitMemoryRequest(ctx.msg.text))return fail('Pídeme explícitamente guardar ese dato.');if(sensitiveMemory(args.body))return fail('No guardo contraseñas, tokens ni datos sensibles.');
      await ctx.c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`memory:${ctx.actor.id}`]);
      const r=await ctx.c.query<{count:number}>('SELECT count(*)::int AS count FROM user_memories WHERE user_id=$1',[ctx.actor.id]);
      if(r.rows[0]!.count>=product.memoryLimit)return fail(`Tu memoria está llena (${product.memoryLimit} datos). Borra uno primero.`);
      await ctx.c.query('INSERT INTO user_memories(user_id,body) VALUES($1,$2)',[ctx.actor.id,args.body]);return ok('Guardé ese dato en tu memoria personal.');}}),
  defineTool({...base,name:'memory.list',capability:{summary:'Consultar recuerdos en privado.',produces:'memorias'},description:'Ver tu memoria personal en privado.',examples:['bot qué sabes de mí'],risk:'read',args:z.strictObject({}),
    async run(ctx){if(ctx.chat.isGroup)return fail('Pídemelo por privado.');const r=await ctx.c.query<{id:string;body:string}>('SELECT id,body FROM user_memories WHERE user_id=$1 ORDER BY id',[ctx.actor.id]);return ok(r.rows.map(m=>`#${m.id}: ${m.body}`).join('\n') || 'No tengo recuerdos tuyos.');}}),
  defineTool({...base,name:'memory.forget',capability:{summary:'Olvidar dato personal o todo.',produces:'recibo'},description:'Borrar una memoria o todas con confirmación.',examples:['bot olvida 3','bot olvídalo todo'],risk:'destructive',args:z.strictObject({target:z.string().min(1).max(product.memoryChars)}),
    async run(ctx,args){const r=await ctx.c.query('DELETE FROM user_memories WHERE user_id=$1 AND ($2=\'todo\' OR id::text=$2 OR body ILIKE $3)',[ctx.actor.id,args.target,`%${args.target.replaceAll('%','\\%').replaceAll('_','\\_')}%`]);return ok(`Borré ${r.rowCount} recuerdos.`);}}),
];
