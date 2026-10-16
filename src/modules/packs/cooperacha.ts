import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import type { ToolCtx } from '../../core/tools.js';
import { transaction,type Db } from '../../db/client.js';
import { EconomyError,moveXp,wallet } from '../xp/service.js';
import { chatLock,enqueue,lockChatWallets } from '../games/state.js';
import { libraryAllowed } from '../library/access.js';
import { reserve,release,type Order,event } from './orders.js';
export type Cooperacha={id:string;chat_id:string;owner_id:string;goal:number;total:number;order_id:string;status:string;expires_at:Date};
const describe=(co:Cooperacha)=>`Cooperacha ${co.id}: ${co.total}/${co.goal} XP; ${co.status}. Vence ${co.expires_at.toISOString()}. Premio: pack anunciado para todo el grupo. Cancelación administrativa: 100 %; vencimiento: ${product.cooperachaRefundPercent} % (redondeado hacia abajo por aporte).`;
export async function openCooperacha(ctx:ToolCtx,goal:number=product.cooperachaGoal,category?:string):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);await lockChatWallets(ctx.c,ctx.chat.id,ctx.actor.id);
  if(!Number.isInteger(goal) || goal<product.cooperachaMinGoal || goal>product.cooperachaMaxGoal)throw new EconomyError('Meta fuera de rango.');
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id,true))throw new EconomyError('No.');
  const prior=(await ctx.c.query<Cooperacha>('SELECT * FROM cooperachas WHERE chat_id=$1 AND owner_id=$2 AND source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];if(prior)return describe(prior);
  if((await ctx.c.query("SELECT 1 FROM cooperachas WHERE chat_id=$1 AND status='open'",[ctx.chat.id])).rowCount)throw new EconomyError('Ya hay una cooperacha activa aquí.');
  const id=randomUUID();
  const order=await reserve(ctx.c,{chat:ctx.chat.id,user:ctx.actor.id,source:ctx.msg.id,kind:'cooperacha',...(category?{category}:{})});
  const co=(await ctx.c.query<Cooperacha>(`INSERT INTO cooperachas(id,chat_id,owner_id,source_id,goal,order_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::int*interval '1 minute') RETURNING *`,[id,ctx.chat.id,ctx.actor.id,ctx.msg.id,goal,order.id,product.cooperachaMinutes])).rows[0]!;
  await wallet(ctx.c,'system:community');
  const count=(await ctx.c.query<{n:number}>('SELECT count(*)::int n FROM pack_order_items WHERE order_id=$1',[order.id])).rows[0]!.n;
  return `${describe(co)}\nReservados ${count} elementos${category?` de ${category}`:''}, pedido ${order.id}. Aporta con «bot aporto 50».`;
}
export async function contribute(ctx:ToolCtx,amount:number):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);await lockChatWallets(ctx.c,ctx.chat.id,ctx.actor.id);
  if(!Number.isSafeInteger(amount) || amount<=0)throw new EconomyError('La aportación debe ser positiva.');
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))throw new EconomyError('No.');
  const prior=(await ctx.c.query<{amount:number;cooperacha_id:string}>('SELECT * FROM cooperacha_contributions WHERE chat_id=$1 AND user_id=$2 AND source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];
  if(prior)return `Aporte ${prior.amount} XP ya registrado en cooperacha ${prior.cooperacha_id}.`;
  const co=(await ctx.c.query<Cooperacha>("SELECT * FROM cooperachas WHERE chat_id=$1 AND status='open' AND expires_at>clock_timestamp() FOR UPDATE",[ctx.chat.id])).rows[0];
  if(!co)throw new EconomyError('No hay cooperacha abierta.');
  const accepted=Math.min(amount,co.goal-co.total),id=randomUUID();
  await moveXp(ctx.c,ctx.actor.id,-accepted,'cooperacha_reserve',id,ctx.chat.id);
  await ctx.c.query('INSERT INTO cooperacha_contributions(id,cooperacha_id,user_id,source_id,amount,chat_id) VALUES($1,$2,$3,$4,$5,$6)',[id,co.id,ctx.actor.id,ctx.msg.id,accepted,ctx.chat.id]);
  co.total+=accepted;
  const completed=co.total===co.goal;
  await ctx.c.query('UPDATE cooperachas SET total=$2,status=$3 WHERE id=$1',[co.id,co.total,completed?'completed':'open']);
  const order=(await ctx.c.query<Order>('SELECT * FROM pack_orders WHERE id=$1 FOR UPDATE',[co.order_id])).rows[0]!;
  await event(ctx.c,order,'contribution',{user:ctx.actor.id,amount:accepted,contribution:id});
  if(completed){
    await moveXp(ctx.c,'system:community',co.total,'cooperacha_success',co.id,co.chat_id);
    await release(ctx.c,order,co.chat_id);
    await enqueue(ctx.c,co.chat_id,`cooperacha:release:${co.id}`,`Cooperacha ${co.id} completada: ${co.total} XP. Recompensa del pedido ${order.id} en cola para todo este grupo; entrega aún no confirmada.`);
  }
  return `Aporte aceptado: ${accepted} XP${accepted<amount?' (ajustado al restante)':''}. Cooperacha ${co.id}: ${co.total}/${co.goal}.${completed?' Meta alcanzada; recompensa grupal en cola.':''}`;
}
export async function closeCooperacha(c:PoolClient,co:Cooperacha,status:'cancelled'|'expired'):Promise<void>{
  const current=(await c.query<Cooperacha>('SELECT * FROM cooperachas WHERE id=$1 FOR UPDATE',[co.id])).rows[0];
  if(!current || current.status!=='open')return;
  co=current;
  const rows=(await c.query<{id:string;user_id:string;amount:number}>('SELECT * FROM cooperacha_contributions WHERE cooperacha_id=$1 ORDER BY user_id,id',[co.id])).rows;
  let retained=0;
  for(const row of rows){
    const refund=status==='cancelled'?row.amount:Math.floor(row.amount*product.cooperachaRefundPercent/100);
    await moveXp(c,row.user_id,refund,'cooperacha_refund',row.id,co.chat_id);retained+=row.amount-refund;
    await c.query('UPDATE cooperacha_contributions SET refund=$2 WHERE id=$1',[row.id,refund]);
  }
  if(retained)await moveXp(c,'system:community',retained,'community_retention',co.id,co.chat_id);
  await c.query('UPDATE cooperachas SET status=$2 WHERE id=$1 AND status=\'open\'',[co.id,status]);
  await c.query("UPDATE pack_orders SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[co.order_id]);
  const order=(await c.query<Order>('SELECT * FROM pack_orders WHERE id=$1',[co.order_id])).rows[0]!;
  await event(c,order,status,{total:co.total,retained});
  await enqueue(c,co.chat_id,`cooperacha:close:${co.id}`,`Cooperacha ${co.id} ${status==='cancelled'?'cancelada: devolución 100 %':'vencida: devolución 80 % por aporte'}. Devueltos ${co.total-retained} XP; comunidad ${retained} XP.`);
}
export async function cancelCooperacha(ctx:ToolCtx):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);await lockChatWallets(ctx.c,ctx.chat.id,ctx.actor.id);
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id,true))throw new EconomyError('No.');
  const prior=(await ctx.c.query<Cooperacha>('SELECT * FROM cooperachas WHERE chat_id=$1 AND cancel_actor_id=$2 AND cancel_source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];
  if(prior)return `Cooperacha ${prior.id} ya cancelada; devolución 100 % registrada.`;
  const co=(await ctx.c.query<Cooperacha>("SELECT * FROM cooperachas WHERE chat_id=$1 AND status='open' FOR UPDATE",[ctx.chat.id])).rows[0];
  if(!co)throw new EconomyError('No hay cooperacha abierta.');
  await closeCooperacha(ctx.c,co,'cancelled');
  await ctx.c.query('UPDATE cooperachas SET cancel_source_id=$2,cancel_actor_id=$3 WHERE id=$1',[co.id,ctx.msg.id,ctx.actor.id]);
  return `Cooperacha ${co.id} cancelada; devolví 100 % de los aportes.`;
}
export async function cooperachaStatus(c:PoolClient,chat:string):Promise<string>{
  const co=(await c.query<Cooperacha>('SELECT * FROM cooperachas WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1',[chat])).rows[0];return co?describe(co):'No hay cooperacha registrada aquí.';
}
export async function tickCooperachas(db:Db):Promise<void>{
  const rows=(await db.query<Cooperacha>("SELECT * FROM cooperachas WHERE status='open' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1",[product.libraryResults])).rows;
  for(const row of rows)await transaction(db,async c=>{
    const held=(await c.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1)) held',[`games:${row.chat_id}`])).rows[0]?.held;if(!held)return;
    const ids=(await c.query<{user_id:string}>('SELECT DISTINCT user_id FROM cooperacha_contributions WHERE cooperacha_id=$1',[row.id])).rows.map(r=>r.user_id);ids.push('system:community');
    await c.query('SELECT user_id FROM wallets WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR UPDATE NOWAIT',[ids]);
    const co=(await c.query<Cooperacha>("SELECT * FROM cooperachas WHERE id=$1 AND status='open' AND expires_at<=clock_timestamp() FOR UPDATE",[row.id])).rows[0];
    if(!co)return;
    const flags=await c.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb");if(flags.rowCount)return;
    // Financial expiry is owed even when permissions/module were revoked; no reward is released.
    await closeCooperacha(c,co,'expired');
  }).catch((error:unknown)=>{if(typeof error==='object' && error!==null && 'code' in error && error.code==='55P03')return;throw error;});
}
