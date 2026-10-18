import { observer } from '../../observer/index.js';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import type { ToolCtx } from '../../core/tools.js';
import { moduleEnabled } from '../../core/permissions.js';
export class EconomyError extends Error {}
export type Wallet={balance:number;streak:number;last_daily_at:Date|null};
export const level=(balance:number):number=>1+Math.floor(balance/product.xpLevelStep);
export async function wallet(c:PoolClient,user:string):Promise<Wallet>{
  await c.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
  return (await c.query<Wallet>('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',[user])).rows[0]!;
}
/** Caller owns the transaction. Lock before checking the unique ledger reference. */
export async function moveXp(c:PoolClient,user:string,delta:number,reason:string,ref:string,chat:string):Promise<boolean>{
  if(!Number.isSafeInteger(delta))throw new EconomyError('Cantidad de XP inválida.');
  const current=await wallet(c,user);
  if((await c.query('SELECT 1 FROM xp_ledger WHERE user_id=$1 AND reason=$2 AND ref=$3',[user,reason,ref])).rowCount)return false;
  if(current.balance+delta<0)throw new EconomyError('No tienes XP suficiente.');
  await c.query('INSERT INTO xp_ledger(user_id,delta,reason,ref,chat_id,config_version) VALUES($1,$2,$3,$4,$5,$6)',[user,delta,reason,ref,chat,product.economyVersion]);
  await c.query('UPDATE wallets SET balance=balance+$2 WHERE user_id=$1',[user,delta]);
  observer.emit(()=>({eventType:'BUSINESS_MUTATION',stage:'xp.ledger_wallet',payload:{user,chat,delta,reason,ref,before:current.balance,after:current.balance+delta,transaction:'pending_commit'}}));
  return true;
}
export function dailyReward(roll:number,streak:number):number{
  let threshold=0;
  for(const prize of product.dailyPrizes){threshold+=prize.weight;if(roll<threshold)return prize.xp+(prize.xp>0?Math.min(product.streakBonusMax,(streak-1)*product.streakBonus):0);}
  throw new EconomyError('Azar fuera de rango.');
}
export async function daily(c:PoolClient,user:string,chat:string,ref:string,now:Date,roll=()=>randomInt(100)):Promise<Wallet>{
  const current=await wallet(c,user);
  if((await c.query('SELECT 1 FROM xp_ledger WHERE user_id=$1 AND reason=\'daily\' AND ref=$2',[user,ref])).rowCount)return current;
  const elapsed=current.last_daily_at?now.getTime()-current.last_daily_at.getTime():Infinity;
  if(elapsed<product.dailyCooldownMs)throw new EconomyError('Tu diario todavía no cumple 24 horas.');
  const streak=elapsed<=product.streakWindowMs?current.streak+1:1;
  await moveXp(c,user,dailyReward(roll(),streak),'daily',ref,chat);
  await c.query('UPDATE wallets SET last_daily_at=$2,streak=$3 WHERE user_id=$1',[user,now,streak]);
  return wallet(c,user);
}
export async function activity(ctx:ToolCtx):Promise<void>{
  if(!ctx.chat.isGroup || !moduleEnabled(ctx.chat,'xp',ctx.config) || ctx.msg.fromMe || ctx.config.BOT_JIDS.includes(ctx.actor.id) || ctx.msg.text.trim().length<product.xpActivityMinChars)return;
  if(ctx.actor.role!=='owner' && !ctx.actor.groupMember)return;
  // Serialize both cooldown and wallet even when messages arrive from different chats.
  await wallet(ctx.c,ctx.actor.id);
  const mark=await ctx.c.query<{last_at:Date}>('SELECT last_at FROM activity_marks WHERE user_id=$1 AND chat_id=$2',[ctx.actor.id,ctx.chat.id]);
  if(mark.rows[0] && ctx.msg.ts.getTime()-mark.rows[0].last_at.getTime()<product.xpActivityCooldownMs)return;
  const settings=await ctx.c.query<{until:string|null}>("SELECT settings->>'happy_hour_until' AS until FROM chats WHERE id=$1",[ctx.chat.id]);
  const until=settings.rows[0]?.until;
  const happy=until && new Date(until).getTime()>ctx.now.getTime();
  const ref=JSON.stringify([ctx.chat.id,ctx.msg.id]);
  if(!await moveXp(ctx.c,ctx.actor.id,happy?product.xpHappyActivity:product.xpActivity,'activity',ref,ctx.chat.id))return;
  await ctx.c.query('INSERT INTO activity_marks(user_id,chat_id,last_at) VALUES($1,$2,$3) ON CONFLICT(user_id,chat_id) DO UPDATE SET last_at=excluded.last_at',[ctx.actor.id,ctx.chat.id,ctx.msg.ts]);
}
