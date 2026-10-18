import pg from 'pg';
import type { ObserverEvent } from './types.js';
export function observerPool(url:string):pg.Pool{return new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:500,query_timeout:1000,statement_timeout:900,application_name:'botsky-observer'});}
export async function insertEvents(pool:pg.Pool,events:ObserverEvent[]):Promise<void>{
  if(!events.length)return;
  await pool.query(`INSERT INTO observer_events(event_id,turn_id,chat_id,actor_id,provider_msg_id,event_type,stage,sequence,created_at,payload,process_instance,git_commit,correlation)
    SELECT (e->>'eventId')::uuid,e->>'turnId',e->>'chatId',e->>'actorId',e->>'providerMsgId',e->>'eventType',e->>'stage',e->>'sequence',(e->>'timestamp')::timestamptz,e->'payload',e->>'processInstance',e->>'gitCommit',e-'payload'
    FROM jsonb_array_elements($1::jsonb) e ON CONFLICT(event_id) DO NOTHING`,[JSON.stringify(events)]);
}
