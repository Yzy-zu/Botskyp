import { AsyncLocalStorage } from 'node:async_hooks';
import type { QueryResult,QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import { Recorder,observerWarning } from './recorder.js';
import { insertEvents,observerPool } from './postgres.js';
import type { Correlation,EventInput } from './types.js';
const clients=new WeakMap<object,Correlation>();
const context=new AsyncLocalStorage<Correlation>();
let recorder:Recorder|undefined;
let lookup:ReturnType<typeof observerPool>|undefined;
/** All instrumentation uses this boundary, including lazy payload construction. */
export const observer={
  get enabled():boolean{return Boolean(recorder);},
  emit(input:EventInput|(()=>EventInput)):void{if(!recorder)return;try{recorder.emit(typeof input==='function'?input():input,context.getStore());}catch{observerWarning();}},
  scope<T>(ids:Correlation,fn:()=>T):T {return recorder?context.run({...context.getStore(),...ids},fn):fn();},
  releaseClient(client:object):void{clients.delete(client);},
  clientIds(client:object):Correlation{return clients.get(client) ?? {};},
  bindClient(client:object,ids:Correlation):void{if(recorder){clients.set(client,ids);context.enterWith({...context.getStore(),...ids});}},
  bind(ids:Correlation):void{if(recorder)context.enterWith({...context.getStore(),...ids});},
  ids():Correlation{return recorder?context.getStore() ?? {}:{};},
  health():unknown{return recorder?{enabled:true,...recorder.health}:{enabled:false};},
  async operationSource(value:unknown):Promise<Correlation>{
    if(!recorder || !lookup || !value || typeof value!=='object')return {};
    try{
      const payload=value as {opId?:unknown};
      if(typeof payload.opId==='string'){
        const row=(await lookup.query<{job_id:string;source_id:string;chat_id:string;actor_id:string}>('SELECT job_id,source_id,chat_id,actor_id FROM bulk_ops WHERE id=$1',[payload.opId])).rows[0];
        if(row)return {jobId:row.job_id,sourceMessageId:row.source_id,chatId:row.chat_id,actorId:row.actor_id};
      }
    }catch{observerWarning();}
    return {};
  },
  async source<T>(ids:Correlation,fn:()=>Promise<T>):Promise<T>{
    if(!recorder)return fn();
    let resolved:Correlation={...ids};
    try{
      if(lookup && ids.jobId){
        const job=(await lookup.query<{chat_id:string;owner_id:string;source_message_id:string}>('SELECT chat_id,owner_id,source_message_id FROM jobs WHERE id=$1',[ids.jobId])).rows[0];
        if(job)resolved={...resolved,chatId:job.chat_id,actorId:job.owner_id,sourceMessageId:resolved.sourceMessageId || job.source_message_id};
      }
      if(lookup && resolved.sourceMessageId){
        const row=(await lookup.query<{id:string;actor_id:string;source_message_id:string}>(`SELECT t.id,coalesce(a.user_id,i.payload->>'senderId') actor_id,t.source_message_id
          FROM message_turns t JOIN inbox i ON i.turn_id=t.id LEFT JOIN user_aliases a ON a.alias=i.payload->>'senderId' AND a.evidence NOT LIKE 'conflict:%'
          WHERE t.source_message_id=$1 AND ($2::text IS NULL OR t.chat_id=$2 OR t.resolved_chat_id=$2) ORDER BY t.created_at DESC LIMIT 1`,[resolved.sourceMessageId,resolved.chatId ?? null])).rows[0];
        if(row)resolved={...resolved,turnId:row.id,actorId:row.actor_id,providerMsgId:row.source_message_id};
      }
    }catch{observerWarning();}
    return context.run(resolved,fn);
  },
  async rows<R extends QueryResultRow>(query:Promise<QueryResult<R>>,stage:string,eventType:EventInput['eventType']='BUSINESS_MUTATION'):Promise<QueryResult<R>>{
    const result=await query;
    observer.emit(()=>({eventType,stage,payload:{rows:result.rows,rowCount:result.rowCount,transaction:'pending_commit'}}));
    return result;
  },
  async snapshot(kind:'jobs'|'outbox',id:string,stage:string):Promise<void>{
    if(!recorder || !lookup)return;
    try{const row=(await lookup.query(`SELECT * FROM ${kind} WHERE id=$1`,[id])).rows[0];
      if(row)observer.emit({eventType:kind==='outbox'?(row.status==='sent'?'OUTBOX_SENT':['failed','uncertain'].includes(row.status)?'OUTBOX_FAILED':row.status==='sending'?'OUTBOX_STARTED':'OUTBOX_QUEUED'):(row.status==='done'?'JOB_COMPLETED':row.status==='failed'?'JOB_FAILED':'JOB_OUTPUT'),stage,payload:{...row,finalReply:kind==='outbox'?row.payload?.text:undefined}});
      if(kind==='jobs' && row?.outbox_id)await observer.snapshot('outbox',String(row.outbox_id),stage+'.delivery');
    }catch{observerWarning();}
  },
  async flush():Promise<void>{try{await recorder?.flush();}catch{observerWarning();}},
};
export function startObserver(config:Config,role:'app'|'worker'):()=>Promise<void>{
  if(!config.OBSERVER_ENABLED)return async()=>{};
  try{
    const pool=observerPool(config.DATABASE_URL);lookup=pool;pool.on('error',observerWarning);
    const secrets=[...config.GEMINI_API_KEYS,config.EVOLUTION_APIKEY,config.WEBHOOK_SECRET];
    // Values only: never persist an environment dump.
    for(const [key,value] of Object.entries(process.env))if(value && /(?:key|password|secret|token|cookie|database_url)/i.test(key))secrets.push(value);
    recorder=new Recorder({dir:config.OBSERVER_SPOOL_DIR,gitCommit:process.env.BOTSKY_GIT_COMMIT ?? 'unknown',retentionDays:config.OBSERVER_RETENTION_DAYS,maxSpoolMb:config.OBSERVER_MAX_SPOOL_MB,secrets},
      {insert:events=>insertEvents(pool,events),cleanup:async days=>{await pool.query("DELETE FROM observer_events WHERE id IN (SELECT id FROM observer_events WHERE created_at<clock_timestamp()-$1::int*interval '1 day' LIMIT 10000)",[days]);}});
    recorder.start();observer.emit({eventType:'PROCESS_LIFECYCLE',stage:role,payload:{state:'started',role}});
    return async()=>{try{observer.emit({eventType:'PROCESS_LIFECYCLE',stage:role,payload:{state:'stopping',role}});await recorder?.close();recorder=undefined;lookup=undefined;await pool.end();}catch{observerWarning();}};
  }catch{observerWarning();return async()=>{};}
}
