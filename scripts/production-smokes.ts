import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.js';
import {createDb} from '../src/db/client.js';
import {buildEvolutionPayload,generateProviderMessageId} from '../qa/e2e/evolution-payload.js';
import {collectTurnResult,seedMediaFixture} from '../qa/e2e/result-collector.js';
import type {QaTurnResult} from '../qa/e2e/types.js';

process.loadEnvFile('.env');
const config=readConfig(process.env);
// Resolve the existing Compose service; no fixed container address or copied credentials.
const container=execFileSync('docker',['compose','-p','botsky','ps','-q','postgres'],{encoding:'utf8'}).trim();
const networks=JSON.parse(execFileSync('docker',['inspect','--format','{{json .NetworkSettings.Networks}}',container],{encoding:'utf8'})) as Record<string,{IPAddress:string}>;
const address=networks.botsky_internal?.IPAddress;
assert(address,'Botsky PostgreSQL network unavailable');
const url=new URL(config.DATABASE_URL);url.hostname=address;
const db=createDb(url.toString());
const owner=config.OWNER_JIDS[0]!;
const chat=config.LAB_CHAT_ID;
const runId=`prueba-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
const sourceIds:string[]=[];
const results:QaTurnResult[]=[];

async function send(text:string,actor=owner,fixture?:string):Promise<QaTurnResult>{
  const id=generateProviderMessageId('PROD_SMOKE');sourceIds.push(id);
  if(fixture)await seedMediaFixture(db,chat,actor,id,fixture);
  const payload=buildEvolutionPayload({instance:config.INSTANCE,providerMessageId:id,chatId:chat,actorId:actor,
    text,mentions:config.BOT_JIDS, ...(fixture?{attachments:[{kind:'image' as const,fixturePath:fixture}]}:{})});
  const response=await fetch(`http://127.0.0.1:${process.env.BIND_PORT ?? '3000'}/webhook`,{
    method:'POST',headers:{'content-type':'application/json','x-webhook-secret':config.WEBHOOK_SECRET},body:JSON.stringify(payload)});
  assert(response.ok,`Webhook HTTP ${response.status}`);
  const result=await collectTurnResult(db,results.length,id,chat,actor,text,response.status,{},undefined,{timeoutMs:90000});
  results.push(result);
  assert.equal(result.status,'PASS',`${text}: ${result.failureClass}; ${result.errors.join(', ')}`);
  assert(!result.toolCalls.some(t=>t.policyCode==='QA_SUPPRESSED' || t.executionStatus==='qa_suppressed'
    || (t.result as {code?:string}).code==='QA_SUPPRESSED'),'Normal traffic was QA suppressed');
  return result;
}
function tool(result:QaTurnResult,name:string,status='ok'){
  const call=result.toolCalls.find(t=>t.toolName===name);
  assert(call,`Missing tool ${name}`);assert.equal(call.executionStatus,status);return call;
}
async function flag(){return (await db.query<{value:boolean}>("SELECT value FROM system_flags WHERE key='maintenance'")).rows[0]?.value===true;}
async function reminderCount(){return (await db.query<{n:number}>('SELECT count(*)::int n FROM reminders WHERE chat_id=$1 AND owner_id=$2',[chat,owner])).rows[0]!.n;}
async function cleanup(){
  // Only receipt IDs from our unique source messages authorize removal of test business data.
  const receipts=(await db.query<{tool_name:string;result_json:{data?:{reminderId?:string}}}>(
    `SELECT e.tool_name,e.result_json FROM tool_executions e JOIN message_turns t ON t.id=e.turn_id
     WHERE t.source_message_id=ANY($1::text[]) AND e.status='ok' AND e.chat_id=$2 AND e.actor_id=$3`,[sourceIds,chat,owner])).rows;
  for(const receipt of receipts){
    const id=receipt.result_json?.data?.reminderId;if(!id)continue;
    if(receipt.tool_name==='reminders.create')await db.query('DELETE FROM reminders WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND outbox_id IS NULL',[id,chat,owner]);

  }
  await db.query(`DELETE FROM notes n USING tool_executions e,message_turns t
    WHERE e.turn_id=t.id AND t.source_message_id=ANY($1::text[]) AND e.tool_name='notes.create' AND e.status='ok'
    AND n.chat_id=$2 AND n.author_id=$3 AND n.chat_id=e.chat_id AND n.author_id=e.actor_id
    AND n.body=e.input_args->>'body' AND n.created_at>=t.created_at AND n.created_at<=e.finished_at`,[sourceIds,chat,owner]);
  const sessionIds=results.flatMap(r=>r.relevantSession?.id?[r.relevantSession.id]:[]);
  await db.query("UPDATE sessions_v2 SET status='cancelled' WHERE id=ANY($1::uuid[]) AND chat_id=$2 AND actor_id=$3 AND status='active'",[sessionIds,chat,owner]);
  // Expire only this run's retained inputs/outputs; preserve job/outbox delivery evidence.
  await db.query(`UPDATE chat_artifacts SET expires_at=clock_timestamp() WHERE chat_id=$2 AND actor_id=$3
    AND (source_message_id=ANY($1::text[]) OR job_id IN (SELECT id FROM jobs WHERE source_message_id=ANY($1::text[])))`,[sourceIds,chat,owner]);
  await db.query(`UPDATE media_attachments SET expires_at=clock_timestamp() WHERE chat_id=$2 AND owner_id=$3
    AND (source_message_id=ANY($1::text[]) OR job_id IN (SELECT id FROM jobs WHERE source_message_id=ANY($1::text[])))`,[sourceIds,chat,owner]);
}
async function main(){
  assert.equal(config.OBSERVER_ENABLED,false,'Observer must remain false');
  assert.equal(await flag(),false,'Maintenance already active; refusing smoke');
  assert(!(await db.query("SELECT 1 FROM sessions_v2 WHERE chat_id=$1 AND actor_id=$2 AND status='active' AND expires_at>now()",[chat,owner])).rowCount,'Owner has an active session; preserve it');
  const member=process.env.PRODUCTION_SMOKE_MEMBER ?? (await db.query<{user_id:string}>(
    'SELECT user_id FROM group_memberships WHERE chat_id=$1 AND NOT is_admin AND user_id<>ALL($2::text[]) ORDER BY user_id LIMIT 1',[chat,[...config.OWNER_JIDS,...config.BOT_JIDS]])).rows[0]?.user_id;

  try{
    const ping=await send('botsky ping');assert.match(ping.finalText ?? '',/pong/i);console.log('A PASS');
    const before=await reminderCount();
    const missing=await send('recuérdame comprar pan');
    tool(missing,'reminders.create','needs_clarification');
    assert(missing.toolCalls.some(t=>(t.result as {code?:string}).code==='MISSING_TIME'));
    assert.equal(await reminderCount(),before);console.log('B PASS zero reminders');
    const base=Date.now();const reminder=await send('recuérdame comprar pan dentro de tres días');
    const created=tool(reminder,'reminders.create');const receipt=created.result as {data:{reminderId:string}};
    const row=(await db.query<{due_at:Date;body:string}>('SELECT due_at,body FROM reminders WHERE id=$1 AND chat_id=$2 AND owner_id=$3',[receipt.data.reminderId,chat,owner])).rows[0];
    assert(row);assert.equal(row.body,'comprar pan');assert(Math.abs(row.due_at.getTime()-base-3*86400000)<120000);console.log('C PASS correct three days');
    const on=await send('pon botsky en mantenimiento');tool(on,'control.maintenance_on');assert(await flag());
    const origin=(await db.query<{call_origin:string}>("SELECT call_origin FROM tool_executions WHERE turn_id=$1 AND tool_name='control.maintenance_on'",[on.turnId])).rows[0];
    assert.equal(origin?.call_origin,'llm');
    const off=await send('desactiva el mantenimiento de botsky');tool(off,'control.maintenance_off');assert.equal(await flag(),false);console.log('D PASS LLM -> Policy -> maintenance true/false');
    const media=await send('haz un sticker de esta imagen',owner,'qa/e2e/fixtures/sample.png');
    tool(media,'media.process','queued');assert(media.jobs.some(j=>j.kind==='media' && j.status==='done'));
    assert(media.outbox.some(o=>o.kind==='media_result' && o.status==='sent'));console.log('E PASS worker done + media_result sent');
    const note=await send(`guarda una nota producción activa ${runId}`);tool(note,'notes.create');
    assert((await db.query('SELECT 1 FROM notes WHERE chat_id=$1 AND author_id=$2 AND position($3 in body)>0',[chat,owner,runId])).rowCount);console.log('F PASS notes.create persisted');
    if(!member){console.log('A-F PASS; G: covered by automated member Policy regression (owner waived live member smoke)');return;}
    const denied=await send('pon botsky en mantenimiento',member);tool(denied,'control.maintenance_on','denied');
    assert(denied.toolCalls.some(t=>(t.result as {code?:string}).code==='DENIED_PERMISSION'));assert.equal(await flag(),false);console.log('G PASS real member denied, zero effect');
    console.log('QA_GATES_IN_PRODUCTION=0; ALL 7 SMOKES PASS');
  }finally{
    if(await flag()){
      // Recovery is limited to the flag this run owns; keep the bot operational after failed assertions.
      await db.query("UPDATE system_flags SET value='false'::jsonb WHERE key='maintenance'");
    }
    await cleanup();console.log('SMOKE_ARTIFACTS_CLEANED=YES');
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Smoke failed');process.exitCode=1;}).finally(()=>db.end());
