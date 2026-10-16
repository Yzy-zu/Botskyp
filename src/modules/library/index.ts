import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,ok,fail,type Tool,type ToolCtx } from '../../core/tools.js';
import { libraryAllowed } from './access.js';
import { categories } from './catalog.js';
import { safeComponent } from './discovery.js';
import { purchase } from '../packs/orders.js';
import { openCooperacha,contribute,cancelCooperacha,cooperachaStatus } from '../packs/cooperacha.js';
import { configureRain,rainSchema } from '../packs/rain.js';
const base={module:'library',permission:'chat.use',scope:'both',risk:'read',modelCallable:false} as const;
const category=z.string().refine(safeComponent).optional();
async function access(ctx:ToolCtx):Promise<boolean>{return libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id);}
export const libraryTools:Tool[]=[
  defineTool({...base,name:'library.categories',modelCallable:true,description:'Consultar categorías descubiertas de las carpetas de la biblioteca.',examples:['bot biblioteca','bot categorías'],args:z.strictObject({}),async run(ctx){return await access(ctx)?ok(`${await categories(ctx.c)}\nPack: ${product.packPrice} XP, ${product.packMinItems}–${product.packMaxItems} archivos; Hora Feliz: ${product.packHappyPrice} XP, ${product.packHappyMinItems}–${product.packHappyMaxItems}. Entrega privada.`):fail('No.');}}),
  defineTool({...base,name:'packs.buy',risk:'write',description:'Comprar pack aleatorio de biblioteca. XP reservado, entrega privada por outbox.',examples:['bot pack','bot pack Memes'],args:z.strictObject({category}),async run(ctx,args){return ok(await purchase(ctx,args.category));}}),
  defineTool({...base,name:'packs.orders',description:'Consultar tus pedidos y su estado de entrega; importes exactos.',examples:['bot packs'],args:z.strictObject({}),async run(ctx){
    if(!await access(ctx))return fail('No.');
    const rows=(await ctx.c.query<{id:string;price:number;status:string;kind:string}>('SELECT * FROM pack_orders WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3',[ctx.chat.id,ctx.actor.id,product.libraryResults])).rows;
    return ok(rows.map(r=>`${r.id}: ${r.kind}, ${r.price} XP, ${r.status}`).join('\n') || 'Sin pedidos aquí.');
  }}),
  defineTool({...base,name:'library.sync',permission:'config.global',risk:'write',description:'Solicitar discovery local o copia de solo lectura desde Drive. Solo owner; asíncrono.',examples:['bot biblioteca actualizar local','bot biblioteca actualizar drive'],args:z.strictObject({source:z.enum(['local','drive'])}),async run(ctx,args){
    if(!await access(ctx))return fail('No.');
    if(args.source==='drive' && !ctx.config.LIBRARY_DRIVE_ENABLED)return fail('Drive no está configurado localmente; la biblioteca local sigue disponible.');
    const r=await ctx.c.query<{id:string}>('INSERT INTO library_syncs(source,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[args.source,ctx.actor.id]);
    return ok(r.rows[0]?`Actualización #${r.rows[0].id} en cola; todavía no se confirma sincronización.`:'Ya hay una actualización de biblioteca pendiente.');
  }}),
  defineTool({...base,name:'library.sync_status',permission:'config.global',description:'Ver estado de sincronización sanitizado, sin rutas ni credenciales.',examples:['bot biblioteca estado'],args:z.strictObject({}),async run(ctx){
    const rows=(await ctx.c.query<{id:string;source:string;status:string;item_count:number|null;finished_at:Date|null}>('SELECT * FROM library_syncs ORDER BY id DESC LIMIT $1',[product.libraryResults])).rows;
    return ok(rows.map(r=>`#${r.id}: ${r.source}, ${r.status}, ${r.item_count ?? 0} elementos${r.finished_at?`, ${r.finished_at.toISOString()}`:''}`).join('\n') || 'Sin sincronizaciones; OAuth/rclone se configura localmente.');
  }}),
  defineTool({...base,name:'cooperacha.open',permission:'chat.configure',scope:'group',risk:'write',description:'Abrir cooperacha con recompensa pack reservada; solo owner/admin. Vencimiento devuelve 80 %.',examples:['bot cooperacha abrir 500','bot cooperacha abrir 500 Memes'],args:z.strictObject({goal:z.number().int().min(product.cooperachaMinGoal).max(product.cooperachaMaxGoal).optional(),category}),async run(ctx,args){return ok(await openCooperacha(ctx,args.goal,args.category));}}),
  defineTool({...base,name:'cooperacha.contribute',scope:'group',permission:'games.use',risk:'write',description:'Aportar XP a la cooperacha; máximo lo que falte.',examples:['bot aporto 50'],args:z.strictObject({amount:z.number().int().positive().max(product.cooperachaMaxGoal)}),async run(ctx,args){return ok(await contribute(ctx,args.amount));}}),
  defineTool({...base,name:'cooperacha.status',scope:'group',permission:'games.use',description:'Consultar cooperacha del grupo y condiciones.',examples:['bot cooperacha'],args:z.strictObject({}),async run(ctx){return await access(ctx)?ok(await cooperachaStatus(ctx.c,ctx.chat.id)):fail('No.');}}),
  defineTool({...base,name:'cooperacha.cancel',scope:'group',permission:'chat.configure',risk:'write',description:'Cancelar cooperacha abierta y devolver 100 %; solo owner/admin.',examples:['bot cooperacha cancelar'],args:z.strictObject({}),async run(ctx){return ok(await cancelCooperacha(ctx));}}),
  defineTool({...base,name:'library.rain',scope:'group',permission:'chat.configure',risk:'write',description:'Configurar lluvia expresa: días, hora CDMX, 1–3 archivos. Una ejecución al día como máximo; omite atrasadas.',examples:['bot lluvia 18:00 lunes,viernes 2','bot lluvia off'],args:z.strictObject({enabled:z.boolean(),config:rainSchema.optional()}),async run(ctx,args){if(args.enabled && !args.config)return fail('Falta horario y cantidad.');return ok(await configureRain(ctx,args.enabled,args.config));}}),
];
