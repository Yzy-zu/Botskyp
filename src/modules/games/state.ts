import { wallet } from '../xp/service.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
export const stateSchema=z.object({
  configVersion:z.string(),bet:z.number().int(),table:z.boolean(),
  players:z.array(z.object({id:z.string(),bet:z.number().int(),hand:z.array(z.number().int()),stood:z.boolean()})),
  deck:z.array(z.number().int()),dealer:z.array(z.number().int()),turn:z.number().int(),
  consequences:z.boolean(),punishmentMinutes:z.number().int(),loser:z.string().optional(),winner:z.string().optional(),
  results:z.record(z.string(),z.number()).optional(),
});
export type GameState=z.infer<typeof stateSchema>;
export type Game={id:string;chat_id:string;owner_id:string;kind:'blackjack'|'roulette'|'airdrop';status:string;state:GameState;version:number;expires_at:Date};
export async function chatLock(c:PoolClient,chat:string):Promise<void>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`games:${chat}`]);}
export async function lockChatWallets(c:PoolClient,chat:string,user?:string):Promise<void>{
  const ids=(await c.query<{user_id:string}>('SELECT DISTINCT user_id FROM game_players WHERE chat_id=$1 AND active',[chat])).rows.map(r=>r.user_id);
  const co=(await c.query<{user_id:string}>(`SELECT DISTINCT p.user_id FROM cooperacha_contributions p
    JOIN cooperachas co ON co.id=p.cooperacha_id WHERE co.chat_id=$1 AND co.status='open'`,[chat])).rows;
  ids.push(...co.map(r=>r.user_id));
  if((await c.query("SELECT 1 FROM cooperachas WHERE chat_id=$1 AND status='open'",[chat])).rowCount)ids.push('system:community');
  if(user)ids.push(user);
  for(const id of [...new Set(ids)].sort())await wallet(c,id);
}
export async function loadGame(c:PoolClient,chat:string,id?:string,user?:string):Promise<Game|undefined>{
  const row=(await c.query<Game>(`SELECT g.* FROM games g WHERE g.chat_id=$1 AND ($2::uuid IS NULL OR g.id=$2)
    AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM game_players p WHERE p.game_id=g.id AND p.user_id=$3 AND p.active))
    AND g.status IN ('lobby','playing','open') ORDER BY g.created_at DESC LIMIT 1 FOR UPDATE`,[chat,id ?? null,user ?? null])).rows[0];
  return row?{...row,state:stateSchema.parse(row.state)}:undefined;
}
export async function saveGame(c:PoolClient,g:Game):Promise<void>{
  const r=await c.query('UPDATE games SET state=$2,status=$3,expires_at=$4,version=version+1 WHERE id=$1 AND version=$5 RETURNING id',[g.id,JSON.stringify(g.state),g.status,g.expires_at,g.version]);
  if(!r.rowCount)throw new Error('Concurrent game update');g.version++;
  if(!['lobby','playing','open'].includes(g.status)){
    await c.query('UPDATE game_players SET active=false WHERE game_id=$1',[g.id]);
    await c.query("UPDATE sessions SET status='done',version=version+1 WHERE kind='game' AND state->>'gameId'=$1 AND status='active'",[g.id]);
  }else{
    await c.query("UPDATE sessions SET expires_at=$2,version=version+1 WHERE kind='game' AND state->>'gameId'=$1 AND status='active'",[g.id,g.expires_at]);
  }
}
export async function gameSession(c:PoolClient,g:Game,user:string):Promise<void>{
  await c.query("UPDATE sessions SET status='expired',version=version+1 WHERE chat_id=$1 AND owner_id=$2 AND status='active' AND expires_at<=clock_timestamp()",[g.chat_id,user]);
  if((await c.query("SELECT 1 FROM sessions WHERE chat_id=$1 AND owner_id=$2 AND status='active'",[g.chat_id,user])).rowCount)throw new Error('Active interaction');
  await c.query("INSERT INTO sessions(chat_id,owner_id,kind,state,accepted_inputs,expires_at) VALUES($1,$2,'game',$3,$4,$5)",[g.chat_id,user,JSON.stringify({gameId:g.id}),JSON.stringify(['carta','plantarse','doblar','estado','cancelar']),g.expires_at]);
}
export function initialState(bet:number=product.gameBet,table=false):GameState{
  return {configVersion:product.economyVersion,bet,table,players:[],deck:[],dealer:[],turn:0,consequences:false,punishmentMinutes:product.roulettePunishmentMinutes};
}
export async function enqueue(c:PoolClient,chat:string,key:string,text:string,kind='text'):Promise<string>{
  const r=await c.query<{id:string}>('INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id',[chat,kind,JSON.stringify({text,sourceId:''}),key]);
  return r.rows[0]!.id;
}
