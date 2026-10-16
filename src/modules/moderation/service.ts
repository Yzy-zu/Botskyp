import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
export async function warnCount(c:PoolClient,chat:string,user:string):Promise<number>{
  await c.query('INSERT INTO moderation_counts(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[chat,user]);
  return (await c.query<{warns:number}>('SELECT warns FROM moderation_counts WHERE chat_id=$1 AND user_id=$2 FOR UPDATE',[chat,user])).rows[0]!.warns;
}
export async function changeWarn(c:PoolClient,chat:string,user:string,actor:string,ref:string,remove=false,source='manual'):Promise<number>{
  const count=await warnCount(c,chat,user);
  const inserted=await c.query('INSERT INTO moderation_events(chat_id,user_id,actor_id,ref,kind,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[chat,user,actor,ref,remove?'unwarn':'warn',source]);
  if(!inserted.rowCount)return count;
  const next=Math.max(0,count+(remove?-1:1));
  await c.query('UPDATE moderation_counts SET warns=$3 WHERE chat_id=$1 AND user_id=$2',[chat,user,next]);return next;
}
export async function rouletteWarn(c:PoolClient,chat:string,user:string,ref:string,minutes:number):Promise<number>{
  const count=await changeWarn(c,chat,user,'system:roulette',ref,false,'roulette');
  if(count>=product.rouletteWarnLimit)await c.query(`INSERT INTO obligations(kind,chat_id,user_id,ref,due_at,detail)
    VALUES('roulette_kick',$1,$2,$3,clock_timestamp(),$4) ON CONFLICT DO NOTHING`,[chat,user,ref,JSON.stringify({punishmentMinutes:minutes})]);
  return count;
}
