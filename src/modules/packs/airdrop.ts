import type { PoolClient } from 'pg';
import type { ToolCtx } from '../../core/tools.js';
import { EconomyError } from '../xp/service.js';
import { libraryAllowed,privateLibraryDestination } from '../library/access.js';
import { reserve,release,type Order } from './orders.js';
export async function reserveAirdrop(ctx:ToolCtx,game:string):Promise<void>{
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id,true))throw new EconomyError('La biblioteca debe estar habilitada para reservar el pack del airdrop.');
  await reserve(ctx.c,{chat:ctx.chat.id,user:ctx.actor.id,source:game,kind:'airdrop'});
}
export async function claimAirdrop(ctx:ToolCtx,game:string):Promise<void>{
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id) || !await privateLibraryDestination(ctx.c,ctx.config,ctx.actor.id))throw new EconomyError('No puedo entregar el pack privado de forma segura.');
  const order=(await ctx.c.query<Order>("SELECT * FROM pack_orders WHERE kind='airdrop' AND source_id=$1 AND chat_id=$2 FOR UPDATE",[game,ctx.chat.id])).rows[0];
  if(!order || order.status!=='reserved')throw new EconomyError('El pack del airdrop no está reservado.');
  await ctx.c.query('UPDATE pack_orders SET user_id=$2 WHERE id=$1',[order.id,ctx.actor.id]);order.user_id=ctx.actor.id;
  await release(ctx.c,order,ctx.actor.id);
}
export async function expireAirdrop(c:PoolClient,game:string):Promise<void>{await c.query("UPDATE pack_orders SET status='cancelled',updated_at=clock_timestamp() WHERE kind='airdrop' AND source_id=$1 AND status='reserved'",[game]);}
