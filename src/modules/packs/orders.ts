import { randomInt,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import type { ToolCtx } from '../../core/tools.js';
import { EconomyError,moveXp,wallet } from '../xp/service.js';
import { chatLock } from '../games/state.js';
import { libraryAllowed,privateLibraryDestination } from '../library/access.js';
import { verifyFile,safeComponent } from '../library/discovery.js';
export type Order={id:string;chat_id:string;user_id:string;destination:string|null;source_id:string;kind:'purchase'|'cooperacha'|'airdrop'|'rain';price:number;happy:boolean;category:string|null;status:string};
export type Reservation={chat:string;user:string;source:string;kind:Order['kind'];category?:string;happy?:boolean;count?:number;destination?:string};
export async function reserve(c:PoolClient,input:Reservation,random:(max:number)=>number=randomInt):Promise<Order>{
  if(input.category && !safeComponent(input.category))throw new EconomyError('Categoría inválida.');
  const prior=(await c.query<Order>('SELECT * FROM pack_orders WHERE kind=$1 AND chat_id=$2 AND user_id=$3 AND source_id=$4 FOR UPDATE',[input.kind,input.chat,input.user,input.source])).rows[0];
  if(prior)return prior;
  const min=input.happy?product.packHappyMinItems:product.packMinItems;
  const max=input.happy?product.packHappyMaxItems:product.packMaxItems;
  const available=(await c.query<{id:string;sha256:string}>(`SELECT DISTINCT ON(sha256) id,sha256 FROM library_items
    WHERE enabled AND ($1::text IS NULL OR lower(category)=lower($1)) ORDER BY sha256,id LIMIT $2`,[input.category ?? null,product.libraryMaxItems])).rows;
  const required=input.count ?? min;
  if(available.length<required)throw new EconomyError('No hay suficientes elementos disponibles para reservar ese pack. No cobré XP.');
  for(let i=available.length-1;i>0;i--){const j=random(i+1);[available[i],available[j]]=[available[j]!,available[i]!];}
  const count=input.count ?? Math.min(available.length,min+random(max-min+1));
  const selected=available.slice(0,count);
  const order:Order={id:randomUUID(),chat_id:input.chat,user_id:input.user,source_id:input.source,kind:input.kind,price:input.kind==='purchase'?(input.happy?product.packHappyPrice:product.packPrice):0,happy:input.happy ?? false,category:input.category ?? null,status:'reserved',destination:input.destination ?? null};
  // Pin immutable bytes and verify BEFORE reserving XP. Missing/changed source paths cannot alter a reserved pack.
  for(const item of selected){
    const blob=(await c.query<{data:Buffer;mime:string;size:number}>('SELECT * FROM library_blobs WHERE sha256=$1 FOR SHARE',[item.sha256])).rows[0];
    if(!blob || !verifyFile(blob.data,blob.mime,item.sha256,blob.size))throw new EconomyError('El pack no está disponible de forma segura. No cobré XP.');
  }
  if(order.price)await moveXp(c,input.user,-order.price,'pack_reserve',order.id,input.chat);
  await c.query(`INSERT INTO pack_orders(id,chat_id,user_id,source_id,kind,price,happy,category,status,destination,config_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10)`,[order.id,input.chat,input.user,input.source,input.kind,order.price,order.happy,order.category,order.destination,product.libraryVersion]);
  for(const [position,item] of selected.entries())await c.query('INSERT INTO pack_order_items(order_id,position,item_id,sha256) VALUES($1,$2,$3,$4)',[order.id,position,item.id,item.sha256]);
  await event(c,order,'reserved',{price:order.price,count:selected.length,category:order.category,happy:order.happy});
  return order;
}
export async function event(c:PoolClient,order:Order,action:string,detail:Record<string,unknown>={}):Promise<void>{
  await c.query('INSERT INTO library_events(order_id,actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4,$5)',[order.id,order.user_id,order.chat_id,action,JSON.stringify(detail)]);
}
export async function release(c:PoolClient,order:Order,destination:string):Promise<void>{
  const current=(await c.query<Order>('SELECT * FROM pack_orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
  if(!current)throw new Error('missing_pack_order');
  Object.assign(order,current);
  if(order.status!=='reserved')return;
  const privatePack=order.kind==='purchase' || order.kind==='airdrop';
  if(privatePack?(destination!==order.user_id || !/^\d+@s\.whatsapp\.net$/.test(destination)):(destination!==order.chat_id || !destination.endsWith('@g.us')))throw new Error('invalid_pack_destination');
  const items=(await c.query<{position:number;item_id:string}>('SELECT * FROM pack_order_items WHERE order_id=$1 ORDER BY position',[order.id])).rows;
  if(!items.length)throw new Error('empty_reserved_pack');
  for(const item of items){
    const out=(await c.query<{id:string}>(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,'library_item',$2,$3)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,[destination,JSON.stringify({text:`Pack ${order.id} · ${item.position+1}/${items.length}`,sourceId:'',attachmentId:item.item_id,orderId:order.id,position:item.position}),`pack:${order.id}:${item.position}`])).rows[0]!;
    await c.query('UPDATE pack_order_items SET outbox_id=$3 WHERE order_id=$1 AND position=$2',[order.id,item.position,out.id]);
  }
  await c.query("UPDATE pack_orders SET status='queued',destination=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[order.id,destination]);
  order.status='queued';order.destination=destination;await event(c,order,'released',{destination});
}
export async function purchase(ctx:ToolCtx,category?:string):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);await wallet(ctx.c,ctx.actor.id);
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))throw new EconomyError('No.');
  // The canonical backend actor is the only possible private recipient.
  if(!/^\d+@s\.whatsapp\.net$/.test(ctx.actor.id))throw new EconomyError('No puedo resolver tu destinatario privado de forma segura.');
  if(!await privateLibraryDestination(ctx.c,ctx.config,ctx.actor.id))throw new EconomyError('Tu entrega privada no está autorizada. No cobré XP.');
  const happy=(await ctx.c.query<{happy:boolean}>("SELECT coalesce((settings->>'happy_hour_until')::timestamptz>clock_timestamp(),false) happy FROM chats WHERE id=$1",[ctx.chat.id])).rows[0]?.happy ?? false;
  const order=await reserve(ctx.c,{chat:ctx.chat.id,user:ctx.actor.id,source:ctx.msg.id,kind:'purchase',destination:ctx.actor.id,happy,...(category?{category}:{})});
  await release(ctx.c,order,ctx.actor.id);
  if(order.status==='confirmed')return `Pedido ${order.id}: entrega privada confirmada por el proveedor; precio ${order.price} XP.`;
  if(order.status==='refunded')return `Pedido ${order.id}: reserva de ${order.price} XP devuelta, sin entrega.`;
  return `Pedido ${order.id}: ${order.price} XP reservados. Entrega privada ${order.status}; aún no confirmada. Consulta «bot packs».`;
}
