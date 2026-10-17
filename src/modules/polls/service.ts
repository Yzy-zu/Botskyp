import type { PoolClient } from 'pg';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { product } from '../../../config/product.js';
import { moduleEnabled,type Chat } from '../../core/permissions.js';
import { fail,ok,type ToolCtx,type ToolResult } from '../../core/tools.js';
type Poll={id:string;chat_id:string;question:string;status:string;closes_at:Date};
export async function results(c:PoolClient,chatId:string,id:string):Promise<ToolResult>{
  const poll=(await c.query<Poll>('SELECT * FROM polls WHERE id=$1 AND chat_id=$2',[id,chatId])).rows[0];
  if(!poll)return fail('No hay esa encuesta en este chat.');
  const options=(await c.query<{idx:number;label:string;votes:number}>(`SELECT o.idx,o.label,count(v.voter_id)::int votes FROM poll_options o
    LEFT JOIN poll_votes v ON v.poll_id=o.poll_id AND v.option_idx=o.idx WHERE o.poll_id=$1 GROUP BY o.idx,o.label ORDER BY o.idx`,[id])).rows;
  const closed=poll.status==='closed' || poll.closes_at.getTime()<=Date.now();
  return ok(`Encuesta #${id}: ${poll.question}\n${options.map(o=>`${o.idx}. ${o.label}: ${o.votes} voto(s)`).join('\n')}\n${closed?'Cerrada':'Abierta'} · cierre ${poll.closes_at.toISOString()}\nVoto único; puedes cambiarlo con «bot votar ${id} <opción>».`,{id,options,closed});
}
export async function createPoll(ctx:ToolCtx,a:{question:string;options:string[];minutes:number}):Promise<ToolResult>{
  await ctx.c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`polls:${ctx.chat.id}`]);
  const existing=(await ctx.c.query<{id:string}>('SELECT id FROM polls WHERE chat_id=$1 AND author_id=$2 AND source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];
  if(existing)return results(ctx.c,ctx.chat.id,existing.id);
  const count=await ctx.c.query<{n:number}>("SELECT count(*)::int n FROM polls WHERE chat_id=$1 AND status='open' AND closes_at>clock_timestamp()",[ctx.chat.id]);
  if(count.rows[0]!.n>=product.pollMaxOpen)return fail('Hay demasiadas encuestas abiertas en este chat.');
  const row=(await ctx.c.query<{id:string}>(`INSERT INTO polls(chat_id,author_id,source_id,question,closes_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5::int*interval '1 minute') RETURNING id`,[ctx.chat.id,ctx.actor.id,ctx.msg.id,a.question,a.minutes])).rows[0]!;
  for(const [i,label] of a.options.entries())await ctx.c.query('INSERT INTO poll_options(poll_id,idx,label) VALUES($1,$2,$3)',[row.id,i+1,label]);
  return results(ctx.c,ctx.chat.id,row.id);
}
export async function vote(ctx:ToolCtx,id:string,option:number):Promise<ToolResult>{
  const poll=(await ctx.c.query<Poll>('SELECT * FROM polls WHERE id=$1 AND chat_id=$2 FOR UPDATE',[id,ctx.chat.id])).rows[0];
  if(!poll)return fail('No hay esa encuesta en este chat.');
  const prior=await ctx.c.query('SELECT 1 FROM poll_vote_events WHERE poll_id=$1 AND voter_id=$2 AND source_id=$3',[id,ctx.actor.id,ctx.msg.id]);
  if(prior.rowCount)return ok(`Voto de la encuesta #${id} ya registrado; no se repitió.`);
  if(poll.status!=='open' || poll.closes_at.getTime()<=Date.now())return fail('Esa encuesta está cerrada.');
  if(!(await ctx.c.query('SELECT 1 FROM poll_options WHERE poll_id=$1 AND idx=$2',[id,option])).rowCount)return fail('Esa opción no existe.');
  await ctx.c.query('INSERT INTO poll_vote_events(poll_id,voter_id,source_id,option_idx) VALUES($1,$2,$3,$4)',[id,ctx.actor.id,ctx.msg.id,option]);
  await ctx.c.query(`INSERT INTO poll_votes(poll_id,voter_id,option_idx) VALUES($1,$2,$3) ON CONFLICT(poll_id,voter_id) DO UPDATE SET option_idx=excluded.option_idx,updated_at=clock_timestamp()`,[id,ctx.actor.id,option]);
  return ok(`Voto registrado en encuesta #${id}: opción ${option}.`);
}
export async function closePoll(ctx:ToolCtx,id:string):Promise<ToolResult>{
  const r=await ctx.c.query("UPDATE polls SET status='closed',closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1 AND chat_id=$2 RETURNING id",[id,ctx.chat.id]);
  return r.rowCount?results(ctx.c,ctx.chat.id,id):fail('No hay esa encuesta en este chat.');
}
export async function tickPolls(db:Db,config:Config):Promise<void>{
  await transaction(db,async c=>{
    const due=await c.query<Poll>("SELECT * FROM polls WHERE status='open' AND closes_at<=clock_timestamp() ORDER BY closes_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",[product.pollTickBatch]);
    for(const p of due.rows){
      await c.query("UPDATE polls SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[p.id]);
      const ch=(await c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[p.chat_id])).rows[0];
      if(!ch?.enabled || !moduleEnabled(ch,'polls',config))continue;
      if((await c.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb")).rowCount)continue;
      const r=await results(c,p.chat_id,p.id);
      if(r.ok)await c.query("INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,'poll_result',$2,$3) ON CONFLICT DO NOTHING",[p.chat_id,JSON.stringify({text:r.reply,sourceId:''}),`poll:closed:${p.id}`]);
    }
  });
}
