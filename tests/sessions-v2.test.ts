import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { db,initialize,reset,context,owner,chat,count } from './r4-harness.js';
import { openClarificationV2,decideSessionV2,coordinateSessionV2,cancelSessionV2,readSessionV2,type SessionV2 } from '../src/core/sessions-v2.js';
import { hasNonEmptyTurnTextV2 } from '../src/core/session-input-v2.js';
import { continueConfirmationV2 } from '../src/core/session-confirmation-v2.js';
import { executeToolV2 } from '../src/core/policy-v2/executor.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import { buildTurnContextV2 } from '../src/core/context-v2.js';
import { observeContextShadowV2 } from '../src/core/router-shadow.js';
import { transaction } from '../src/db/client.js';
const refs=()=>new SafeRefs([]);
beforeAll(initialize);beforeEach(reset);afterAll(()=>db.end());
async function clarify():Promise<SessionV2>{return transaction(db,async c=>(await openClarificationV2(c,'v1_1',{
  actorId:owner,chatId:chat,pendingTool:'reminders.create',partialArgs:{body:'estudiar',time:{kind:'clock',hour:20,minute:0,meridiem:'pm'}},
  missingSlots:[{kind:'choice',field:'date',choices:['today','tomorrow']}],prompt:'¿Para hoy o mañana?',code:'MISSING_DATE',now:new Date(),
}))!);}
it.each([
  'para joi komo alas ocho piem',
  'nel mejor el viernes',
  'cuanto xp tengo',
  'simon',
  'ni madres',
  'de la noche',
  'en la mañana',
  'sí, pero cambia el texto a hola',
  'qué iba a mandar?',
  'reinicia minecraft',
])('SessionV2 never consumes human language “%s” via local regex and leaves session active for Gemini',async text=>{
  const s=await clarify();
  expect(decideSessionV2(s,text,new Date())).toEqual({kind:'not_consumed'});
  await transaction(db,async c=>expect(await coordinateSessionV2(c,'v1_1',s,text,new Date())).toEqual({kind:'not_consumed'}));
  expect((await db.query('SELECT status,partial_args FROM sessions_v2')).rows[0]).toEqual({status:'active',partial_args:s.partial_args});
});
it('validates technical non-empty turn text without hardcoded affirmative/negative word lists',()=>{
  expect(hasNonEmptyTurnTextV2('simon')).toBe(true);
  expect(hasNonEmptyTurnTextV2('   ')).toBe(false);
});
it('projects complete model-safe activeSession in Context Builder without JIDs, UUIDs, hashes or paths',async()=>{
  await clarify();
  await context({text:'para joi komo alas ocho piem'},async ctx=>{
    const snapshot=await buildTurnContextV2(ctx,['productivity']);
    expect(snapshot.envelope.REFERENCE_DATA.activeSession).toMatchObject({
      kind:'clarify',
      pendingTool:'reminders.create',
      partialArgs:{body:'estudiar',time:{kind:'clock',hour:20,minute:0,meridiem:'pm'}},
      missingSlots:['date'],
      lastQuestion:'¿Para hoy o mañana?',
      prompt:'¿Para hoy o mañana?',
    });
    expect(JSON.stringify(snapshot.envelope)).not.toMatch(/@s\.whatsapp\.net|@g\.us|[0-9a-f]{8}-[0-9a-f]{4}|args_hash|logical_action_id|parent_execution_id|\/home\//iu);
  });
});
it('expires without execution and a late confirmation cannot revive the action',async()=>{
  const s=await clarify();const afterExpiry=new Date(s.expires_at.getTime()+1);
  expect(decideSessionV2(s,'sí',afterExpiry)).toEqual({kind:'expired'});
  await transaction(db,async c=>{
    expect(await coordinateSessionV2(c,'v1_1',s,'sí',afterExpiry)).toEqual({kind:'expired'});
    expect(await coordinateSessionV2(c,'v1_1',s,'sí',afterExpiry)).toEqual({kind:'not_consumed'});
  });
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('expired');expect(await count('reminders')).toBe(0);
});
async function nuclearPreview(){
  return context({text:'botsky nuclear hola'},async ctx=>{
    const result=await executeToolV2(ctx,'bulk.nuclear',{text:'hola'},{callOrigin:'fast_path',safeRefMap:refs()});
    expect(result.status).toBe('needs_confirmation');return (result.data as {confirmationId:string}).confirmationId;
  });
}
it('binds pending R3 hash/lineage/expiry and confirms through reevaluation into one child',async()=>{
  const id=await nuclearPreview();
  const pending=(await db.query('SELECT * FROM tool_confirmations_v2 WHERE id=$1',[id])).rows[0]!;
  const s=(await db.query('SELECT * FROM sessions_v2 WHERE confirmation_id=$1',[id])).rows[0]!;
  expect(s).toMatchObject({args_hash:pending.args_hash,logical_action_id:pending.logical_action_id,parent_execution_id:pending.execution_id,expires_at:pending.expires_at,status:'active'});
  expect(await count('bulk_ops')).toBe(0);
  await context({text:'simon'},async ctx=>{
    const result=await continueConfirmationV2(ctx,refs());expect(result.status).toBe('queued');
    expect(await continueConfirmationV2(ctx,refs())).toEqual({status:'not_consumed'});
    const replay=await executeToolV2(ctx,'bulk.nuclear',{},{callOrigin:'session',safeRefMap:refs(),confirmationId:id});expect(replay).toEqual(result);
  });
  expect(await count('bulk_ops')).toBe(1);
  const children=(await db.query('SELECT * FROM tool_executions WHERE parent_execution_id=$1',[pending.execution_id])).rows;
  expect(children).toHaveLength(1);expect(children[0]).toMatchObject({args_hash:pending.args_hash,logical_action_id:pending.logical_action_id,call_origin:'session'});
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
});
it.each(['permission','module','emergency','hash','expiry'] as const)('preserves R3 revalidation after %s changes',async change=>{
  const id=await nuclearPreview();
  if(change==='module')await db.query(`UPDATE chats SET settings='{"modules":{"messaging":false}}' WHERE id=$1`,[chat]);
  if(change==='emergency')await db.query("INSERT INTO system_flags(key,value) VALUES('emergency','true')");
  if(change==='hash')await db.query("UPDATE tool_confirmations_v2 SET resolved_args=jsonb_set(resolved_args,'{text}','\"alterado\"') WHERE id=$1",[id]);
  if(change==='expiry')await db.query("UPDATE sessions_v2 SET created_at=now()-interval '10 minutes',expires_at=now()-interval '1 minute' WHERE confirmation_id=$1",[id]);
  await context({text:'sí'},async ctx=>{
    const cfg=change==='permission'?{...configFor(ctx),OWNER_JIDS:[]}:ctx.config;
    const result=await continueConfirmationV2({...ctx,config:cfg},refs());
    expect(result.status).not.toBe('queued');expect(await count('bulk_ops')).toBe(0);
  });
});
function configFor(ctx:Parameters<typeof continueConfirmationV2>[0]){return ctx.config;}
it('cancelSessionV2 cancels active session, invalidates the R3 handle, and cannot be bypassed by direct confirmation',async()=>{
  const id=await nuclearPreview();
  await context({text:'ni madres'},async ctx=>{
    await ctx.c.query('BEGIN');
    try{expect(await cancelSessionV2(ctx.c,'v1_1',owner,chat,ctx.now)).toBe('cancelled');await ctx.c.query('COMMIT');}
    catch(error){await ctx.c.query('ROLLBACK');throw error;}
  });
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('cancelled');
  await context({text:'sí'},async ctx=>{
    expect((await executeToolV2(ctx,'bulk.nuclear',{},{callOrigin:'session',safeRefMap:refs(),confirmationId:id})).code).toBe('DENIED_CONFIRMATION_INVALIDATED');
  });
  expect(await count('bulk_ops')).toBe(0);
});
it('shadow observes expiry but cannot consume, cancel, confirm or create sessions',async()=>{
  const s=await clarify();
  await context({text:'de la noche'},async ctx=>{
    await ctx.c.query('BEGIN READ ONLY');
    try{
      expect(await coordinateSessionV2(ctx.c,'v1_1_shadow',s,ctx.msg.text,ctx.now)).toEqual({kind:'not_consumed'});
      expect(await cancelSessionV2(ctx.c,'v1_1_shadow',owner,chat,ctx.now)).toBe('not_found');
      expect(await continueConfirmationV2({...ctx,config:{...ctx.config,ROUTER_MODE:'v1_1_shadow'}},refs())).toEqual({status:'not_consumed'});
      expect(await openClarificationV2(ctx.c,'v1_1_shadow',{actorId:owner,chatId:chat,pendingTool:'reminders.create',partialArgs:{},missingSlots:[{kind:'choice',field:'date',choices:['today','tomorrow']}],prompt:'hora',code:'TIME',now:ctx.now})).toBeUndefined();
      await observeContextShadowV2({...ctx,config:{...ctx.config,ROUTER_MODE:'v1_1_shadow'}},['productivity']);
      expect((await readSessionV2(ctx.c,owner,chat))?.status).toBe('active');
    }finally{await ctx.c.query('ROLLBACK');}
  });
  expect(await count('sessions')).toBe(0);expect(await count('reminders')).toBe(0);
});
it('merges partialArgs from active clarification session when Gemini supplies completed time',async()=>{
  await clarify();
  await context({text:'para joi komo alas ocho piem'},async ctx=>{
    const result=await executeToolV2(ctx,'reminders.create',{time:{kind:'tomorrow',hour:8,meridiem:'pm'}},
      {callOrigin:'llm',safeRefMap:refs()});
    expect(result.status).toBe('ok');
    expect((await db.query("SELECT body,to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time FROM reminders")).rows[0]).toEqual({body:'estudiar',local_time:'20:00'});
    expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
  });
});
it('shadow expiry decision leaves the persisted session status and backend handle untouched',async()=>{
  const id=await nuclearPreview();
  await db.query("UPDATE sessions_v2 SET created_at=now()-interval '10 minutes',expires_at=now()-interval '1 minute' WHERE confirmation_id=$1",[id]);
  await context({text:'sí'},async ctx=>{
    await ctx.c.query('BEGIN READ ONLY');
    try{
      const observed=await buildTurnContextV2({...ctx,config:{...ctx.config,ROUTER_MODE:'v1_1_shadow'}});
      expect(observed.metrics.sessionDecision).toBe('expired');
      expect(observed.envelope.REFERENCE_DATA.activeSession).toBeUndefined();
    }finally{await ctx.c.query('ROLLBACK');}
  });
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('active');
  expect((await db.query('SELECT invalidated FROM tool_confirmations_v2')).rows[0]?.invalidated).toBe(false);
  expect(await count('bulk_ops')).toBe(0);
});
it('shows a safe confirmation preview with pendingTool and without hashes or raw resolved_args',async()=>{
  await context({text:'reinicia minecraft'},async ctx=>expect((await executeToolV2(ctx,'minecraft.restart',{},{callOrigin:'fast_path',safeRefMap:refs()})).status).toBe('needs_confirmation'));
  await context({text:'qué iba a hacer?'},async ctx=>{
    const snapshot=(await buildTurnContextV2(ctx)).envelope;
    expect(snapshot.REFERENCE_DATA.activeSession?.preview?.description).toBe('Reinicio de Minecraft');
    expect(snapshot.REFERENCE_DATA.activeSession?.pendingTool).toBe('minecraft.restart');
    expect(JSON.stringify(snapshot)).not.toMatch(/args_hash|resolved_args|logical_action_id|parent_execution_id/);
  });
});

