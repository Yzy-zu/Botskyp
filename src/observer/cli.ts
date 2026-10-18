import { createReadStream } from 'node:fs';
import { readdir,writeFile,chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import pg from 'pg';
import type { ObserverEvent } from './types.js';
const args=process.argv.slice(2),mode=args[0],id=args[1];
if(!['turn','user','chat','errors','health'].includes(mode ?? ''))throw new Error('Usage: observer <turn UUID|user JID|chat JID|errors|health> [--since 2h] [--json] [--out file]');
if(['turn','user','chat'].includes(mode!) && (!id || id.startsWith('--')))throw new Error('Missing turnId/JID');
function option(name:string):string|undefined{const i=args.indexOf(name);return i<0?undefined:args[i+1];}
function since(raw='24h'):Date{
  const match=/^(\d+)(m|h|d)$/.exec(raw);
  const date=match?new Date(Date.now()-Number(match[1])*({m:60_000,h:3600_000,d:86400_000}[match[2]!] ?? 0)):new Date(raw);
  if(!Number.isFinite(date.getTime()))throw new Error('Invalid --since');return date;
}
const start=since(option('--since')),dir=process.env.OBSERVER_SPOOL_DIR ?? '/var/lib/botsky-observer/spool';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:1000,statement_timeout:10000});
const events=new Map<string,ObserverEvent>(),selected=new Set<string>(),jobTurns=new Map<string,string>();
if(mode==='turn')selected.add(id!);
let postgres=false,spool=false;
const errors=['LLM_ERROR','LLM_ATTEMPT_ERROR','TOOL_ERROR','JOB_FAILED','OUTBOX_FAILED','EVOLUTION_ERROR','TURN_FAILED','TRANSACTION_ROLLBACK'];
function matches(e:ObserverEvent):boolean{return new Date(e.timestamp)>=start && (mode==='user'?e.actorId===id:mode==='chat'?e.chatId===id:mode==='errors'?errors.includes(e.eventType):false);}
async function scanSpool(visit:(event:ObserverEvent)=>void):Promise<void>{
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.jsonl')).sort()){
    const stream=createReadStream(join(dir,file)),lines=createInterface({input:stream,crlfDelay:Infinity});
    const failed=()=>{lines.close();process.stderr.write('Observer spool read failed; repeat export if needed.\n');};
    stream.on('error',failed);lines.on('error',failed);
    try{for await(const line of lines){try{const event=JSON.parse(line) as ObserverEvent;if(event.eventId)visit(event);}catch{process.stderr.write(`Incomplete/corrupt record retained in ${file}\n`);}}}
    finally{lines.close();stream.destroy();}
  }
}
try{
  await scanSpool(e=>{if(e.jobId && e.turnId)jobTurns.set(e.jobId,e.turnId);if(matches(e) && e.turnId)selected.add(e.turnId);});spool=true;
}catch{process.stderr.write('Observer spool unavailable.\n');}
try{
  if(mode==='health'){await pool.query('SELECT 1 FROM observer_events LIMIT 1');}
  else{
    if(mode!=='turn'){
      const clause=mode==='user'?'actor_id=$2':mode==='chat'?'chat_id=$2':'event_type=ANY($2::text[])';
      const rows=await pool.query<{turn_id:string|null}>(`SELECT DISTINCT turn_id FROM observer_events WHERE created_at>=$1 AND ${clause}`,[start,mode==='errors'?errors:id]);
      for(const row of rows.rows)if(row.turn_id)selected.add(row.turn_id);
    }
    // Fetch only selected turns, never the whole retention window for a single-turn export.
    const rows=await pool.query<{event:ObserverEvent}>(`SELECT correlation||jsonb_build_object('payload',payload) event FROM observer_events WHERE turn_id=ANY($1::text[])
      OR ($2::boolean AND turn_id IS NULL AND created_at>=$3 AND event_type=ANY($4::text[])) ORDER BY sequence,event_id`,[[...selected],mode==='errors',start,errors]);
    for(const row of rows.rows){events.set(row.event.eventId,row.event);if(row.event.jobId && row.event.turnId)jobTurns.set(row.event.jobId,row.event.turnId);}
  }
  postgres=true;
}catch{process.stderr.write('Observer PostgreSQL unavailable; exporting surviving local spool.\n');}
finally{await pool.end();}
if(mode!=='health' && spool)try{await scanSpool(e=>{const turn=e.turnId ?? (e.jobId?jobTurns.get(e.jobId):undefined);if(turn && selected.has(turn) || mode==='errors' && !turn && matches(e))events.set(e.eventId,e);});}catch{process.stderr.write('Observer spool changed during export; repeat export if needed.\n');}
const timeline=[...events.values()].sort((a,b)=>a.sequence.localeCompare(b.sequence)||a.eventId.localeCompare(b.eventId));
const output=mode==='health'?JSON.stringify({postgres,spool,enabled:process.env.OBSERVER_ENABLED!=='false'},null,2):args.includes('--json')?JSON.stringify(timeline,null,2):`# Botsky observer — ${mode} ${id ?? ''}\n\nPostgres: ${postgres}; spool: ${spool}; events: ${timeline.length}\n\n`+timeline.map(e=>`## ${e.timestamp} ${e.eventType} (${e.stage})\n\nTurn: ${e.turnId ?? '-'}; job: ${e.jobId ?? '-'}; process: ${e.processInstance}; commit: ${e.gitCommit}; sequence: ${e.sequence}\n\n\u0060\u0060\u0060json\n${JSON.stringify(e.payload,null,2)}\n\u0060\u0060\u0060\n`).join('\n');
const path=option('--out');
if(path){await writeFile(path,output+'\n',{mode:0o600});await chmod(path,0o600);}else process.stdout.write(output+'\n');
if(mode==='health' && !(postgres && spool))process.exitCode=1;
