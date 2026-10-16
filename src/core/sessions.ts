import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { product } from '../../config/product.js';
export type Session={id:string;chat_id:string;owner_id:string;kind:'confirm'|'clarify'|'game'|'media';state:unknown;version:number;accepted_inputs:string[]};
export function argumentHash(action:string,args:unknown):string{
  function canonical(value:unknown):unknown{
    if(Array.isArray(value))return value.map(canonical);
    if(value!==null && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify([action,canonical(args)])).digest('hex');
}
export async function activeSession(c:PoolClient,actor:string,chat:string):Promise<Session|undefined>{
  await c.query("UPDATE sessions SET status='expired',version=version+1 WHERE status='active' AND kind<>'game' AND expires_at<=clock_timestamp()");
  return (await c.query<Session>("SELECT * FROM sessions WHERE owner_id=$1 AND chat_id=$2 AND status='active'",[actor,chat])).rows[0];
}
export async function openSession(c:PoolClient,actor:string,chat:string,kind:Session['kind'],state:unknown,inputs:string[]):Promise<void>{
  await c.query("UPDATE sessions SET status='cancelled',version=version+1 WHERE owner_id=$1 AND chat_id=$2 AND status='active'",[actor,chat]);
  await c.query(`INSERT INTO sessions(owner_id,chat_id,kind,state,accepted_inputs,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::int*interval '1 minute')`,[actor,chat,kind,JSON.stringify(state),JSON.stringify(inputs),kind==='confirm'?product.confirmMinutes:product.sessionMinutes]);
}
export async function closeSession(c:PoolClient,session:Session,status:'done'|'cancelled'):Promise<boolean>{
  const result=await c.query(`UPDATE sessions SET status=$3,version=version+1 WHERE id=$1 AND version=$2
    AND status='active' AND expires_at>clock_timestamp() RETURNING id`,[session.id,session.version,status]);
  return Boolean(result.rowCount);
}

export function sessionAccepts(session:Session|undefined,text:string,hasAttachments=false):boolean{
  if(!session)return false;
  if(session.kind==='media')return hasAttachments || /^(?:[1-5]|terminar|cancelar|no)[.!]?$/iu.test(text);
  if(session.kind==='game')return /^(carta|plantarse|doblar|estado|partida|cancelar)[.!]?$/iu.test(text);
  if(session.kind==='clarify' && session.accepted_inputs.includes('contenido'))return text.trim().length>0;
  if(session.kind==='confirm')return /^(s[ií]|no|cancelar)[.!]?$/iu.test(text);
  return /^(?:cancelar$|(?:hoy|ma[ñn]ana|pasado ma[ñn]ana|(?:el )?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\b|(?:a las?|de la|por la)\s|(?:en |dentro de )?\d+\s+(?:minutos?|horas?|d[ií]as?)|\d{4}-\d{2}-\d{2}T)/iu.test(text);
}
