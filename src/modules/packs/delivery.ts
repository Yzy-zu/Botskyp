import { z } from 'zod';
import { product } from '../../../config/product.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import type { Delivery } from '../../wa/types.js';
import { libraryAllowed,privateLibraryDestination } from '../library/access.js';
import { verifyFile } from '../library/discovery.js';
import { extension } from '../media/catalog.js';
import { moveXp } from '../xp/service.js';
import { enqueue } from '../games/state.js';
import { event,type Order } from './orders.js';
const payload=z.strictObject({text:z.string(),sourceId:z.literal(''),attachmentId:z.uuid(),orderId:z.uuid(),position:z.number().int().nonnegative()});
export async function libraryDelivery(db:Db,config:Config,row:{id:string;chat_id:string;payload:unknown}):Promise<Delivery['media']|undefined>{
  const parsed=payload.safeParse(row.payload);if(!parsed.success)return undefined;const p=parsed.data;
  return transaction(db,async c=>{
    const order=(await c.query<Order>('SELECT * FROM pack_orders WHERE id=$1',[p.orderId])).rows[0];
    if(!order || !['queued','pending_review'].includes(order.status) || order.destination!==row.chat_id || !await libraryAllowed(c,config,order.chat_id,order.user_id,order.kind==='rain'))return undefined;
    if(order.kind==='purchase' || order.kind==='airdrop'){
      if(row.chat_id!==order.user_id || !await privateLibraryDestination(c,config,order.user_id))return undefined;
    }else if(row.chat_id!==order.chat_id)return undefined;
    // Stop remaining files after an uncertain/failed send; a partial pack needs review.
    if((await c.query(`SELECT 1 FROM pack_order_items i JOIN outbox o ON o.id=i.outbox_id
      WHERE i.order_id=$1 AND o.id<>$2 AND o.status IN ('failed','uncertain')`,[order.id,row.id])).rowCount)return undefined;
    if(order.kind==='rain' && !(await c.query("SELECT 1 FROM automations WHERE chat_id=$1 AND kind='content_rain' AND enabled",[order.chat_id])).rowCount)return undefined;
    const b=(await c.query<{data:Buffer;mime:string;sha256:string;size:number}>(`SELECT b.* FROM pack_order_items i JOIN library_blobs b ON b.sha256=i.sha256
      WHERE i.order_id=$1 AND i.position=$2 AND i.item_id=$3 AND i.outbox_id=$4`,[p.orderId,p.position,p.attachmentId,row.id])).rows[0];
    if(!b || !verifyFile(b.data,b.mime,b.sha256,b.size))return undefined;
    return {kind:'document',mime:b.mime,base64:b.data.toString('base64'),fileName:`botsky-pack-${p.position+1}.${extension(b.mime)}`};
  });
}
export async function settleOrders(db:Db,config:Config):Promise<void>{
  const rows=(await db.query<Order>(`SELECT p.* FROM pack_orders p WHERE p.status='queued' OR (p.status='pending_review'
    AND EXISTS(SELECT 1 FROM pack_order_items i WHERE i.order_id=p.id)
    AND (NOT EXISTS(SELECT 1 FROM pack_order_items i JOIN outbox o ON o.id=i.outbox_id WHERE i.order_id=p.id AND o.status<>'sent')
      OR NOT EXISTS(SELECT 1 FROM pack_order_items i JOIN outbox o ON o.id=i.outbox_id WHERE i.order_id=p.id AND o.status<>'failed')))
    ORDER BY p.created_at LIMIT $1`,[product.libraryResults])).rows;
  for(const row of rows)await transaction(db,async c=>{
    const held=(await c.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1)) held',[`games:${row.chat_id}`])).rows[0]?.held;if(!held)return;
    // NOWAIT prevents a busy wallet from blocking time-sensitive work.
    await c.query('SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE NOWAIT',[row.user_id]);
    const order=(await c.query<Order>('SELECT * FROM pack_orders WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!order || !['queued','pending_review'].includes(order.status))return;
    const states=(await c.query<{status:string}>(`SELECT o.status FROM pack_order_items i JOIN outbox o ON o.id=i.outbox_id WHERE i.order_id=$1`,[order.id])).rows.map(r=>r.status);
    if(!states.length)return;
    let status:string|undefined;
    if(states.some(s=>s==='uncertain'))status='pending_review';
    else if(states.every(s=>s==='sent'))status='confirmed';
    else if(states.some(s=>s==='queued' || s==='sending'))return;
    else if(states.every(s=>s==='failed')){
      if(order.price)await moveXp(c,order.user_id,order.price,'pack_refund',order.id,order.chat_id);
      status=order.price?'refunded':'failed';
    }else status='pending_review';
    if(order.status===status)return;
    await c.query('UPDATE pack_orders SET status=$2,updated_at=clock_timestamp() WHERE id=$1',[order.id,status]);
    await event(c,order,status);
    const text=status==='confirmed'?`Pedido ${order.id}: entrega confirmada por el proveedor.`:status==='refunded'?`Pedido ${order.id}: no se entregó ningún archivo; devolví ${order.price} XP.`:`Pedido ${order.id}: entrega ${status}; requiere revisión, sin repetir archivos ni devolver una entrega incierta.`;
    await enqueue(c,order.kind==='purchase' || order.kind==='airdrop'?order.user_id:order.chat_id,`pack:status:${order.id}:${status}`,text);
    if(status==='pending_review')for(const owner of config.OWNER_JIDS)await enqueue(c,owner,`pack:review:${order.id}:${owner}`,`Pedido ${order.id}: entrega parcial o incierta; requiere revisión técnica, sin reenvío ni refund automático.`);
    if(status==='pending_review')await c.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('packs.delivery',$1,'Pack incierto o parcial; reserva retenida para revisión')",[order.id]);
  }).catch((error:unknown)=>{if(typeof error==='object' && error!==null && 'code' in error && error.code==='55P03')return;throw error;});
}
