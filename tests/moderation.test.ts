import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { transaction } from '../src/db/client.js';
import { changeWarn,rouletteWarn } from '../src/modules/moderation/service.js';
import { tickObligations } from '../src/modules/moderation/obligations.js';
import { type GroupControl,type Roster } from '../src/wa/group-control.js';
import { MockEvolution } from '../src/wa/mock.js';
import { sendNext,recoverSending } from '../src/wa/outbox.js';
import { db,config,owner,admin,member,message,initialize,resetSchool,context,command,execute } from './school-harness.js';
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
const warnings=async(user=member)=>(await db.query<{warns:number}>('SELECT warns FROM moderation_counts WHERE chat_id=$1 AND user_id=$2',[config.LAB_CHAT_ID,user])).rows[0]?.warns;
const obligations=async()=>(await db.query<{id:string;kind:string;status:string;outbox_id:string}>('SELECT * FROM obligations ORDER BY id')).rows;
function provider():GroupControl & {removed:number;rosterCalls:number;data:Roster;outcome:'accepted'|'retry'|'rejected'|'unknown';failInvite:boolean;failAfter:boolean}{
  return {removed:0,rosterCalls:0,outcome:'accepted',failInvite:false,failAfter:false,
    data:{id:config.LAB_CHAT_ID,participants:[{id:owner,admin:'superadmin'},{id:admin,admin:'admin'},{id:member},{id:'200@s.whatsapp.net',admin:'admin'}]},
    async roster(){this.rosterCalls++;if(this.failAfter && this.removed)throw new Error('network');return structuredClone(this.data);},
    async remove(_chat,user){this.removed++;if(this.outcome==='accepted')this.data.participants=this.data.participants.filter(p=>p.id!==user);return this.outcome;},
    async invite(){if(this.failInvite)throw new Error('invite failed');return `https://chat.whatsapp.com/${'A'.repeat(22)}`;},
  };
}
async function three(user=member){await execute('moderation.config',{enabled:true,minutes:1});for(let i=1;i<=3;i++)await transaction(db,c=>rouletteWarn(c,config.LAB_CHAT_ID,user,`game${i}`,1));}
async function due(){await db.query("UPDATE obligations SET due_at=clock_timestamp()-interval '1 second' WHERE status IN ('pending','sending')");}
it('manual warn is scoped, administrative and deduplicated by real message',async()=>{
  const msg=message('bot warn @600',admin);msg.mentions=[member];
  await context(msg,ctx=>changeWarn(ctx.c,ctx.chat.id,member,ctx.actor.id,msg.id));await context(msg,ctx=>changeWarn(ctx.c,ctx.chat.id,member,ctx.actor.id,msg.id));
  expect(await warnings()).toBe(1);expect((await execute('moderation.change',{remove:false},member)).ok).toBe(false);
  expect((await execute('moderation.change',{remove:false},admin,'400@g.us')).ok).toBe(false);
});
it('manual target must come from actual authenticated mentions and active membership',async()=>{
  expect((await execute('moderation.change',{remove:false,target:member},admin)).ok).toBe(false);
  expect((await execute('moderation.change',{remove:false},admin)).ok).toBe(false);
  const msg=message('bot warn @600',admin);msg.mentions=[member];expect(await command(msg)).toContain('1 warns');
  const other=message('bot quita warn @600',admin);other.mentions=[member];expect(await command(other)).toContain('0 warns');
});
it('manual warns do not cause unconfirmed expulsions and cannot go below zero',async()=>{
  for(let i=0;i<4;i++)await transaction(db,c=>changeWarn(c,config.LAB_CHAT_ID,member,admin,`m${i}`));expect(await warnings()).toBe(4);expect(await obligations()).toHaveLength(0);
  for(let i=0;i<6;i++)await transaction(db,c=>changeWarn(c,config.LAB_CHAT_ID,member,admin,`r${i}`,true));expect(await warnings()).toBe(0);
});
it('three roulette warns create one persistent kick obligation; duplicate loss adds nothing',async()=>{
  await three();await transaction(db,c=>rouletteWarn(c,config.LAB_CHAT_ID,member,'game3',1));expect(await warnings()).toBe(3);expect(await obligations()).toHaveLength(1);
});
it('warns are counted separately per chat',async()=>{
  await transaction(db,c=>changeWarn(c,config.LAB_CHAT_ID,member,admin,'same'));
  await transaction(db,c=>changeWarn(c,'400@g.us',member,admin,'same'));
  expect((await db.query('SELECT * FROM moderation_counts WHERE warns=1')).rowCount).toBe(2);
});
it.each([owner,admin])('owner/admin %s gets warns but is never removed',async user=>{
  await three(user);const p=provider();await tickObligations(db,config,p);expect(p.removed).toBe(0);expect(await warnings(user)).toBe(3);expect((await obligations())[0]?.status).toBe('skipped');
  expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'kick-protected:%'")).rowCount).toBe(1);
});
it('privilege promoted after the loss is rechecked from provider before removal',async()=>{
  await three();const p=provider();p.data.participants.find(m=>m.id===member)!.admin='admin';await tickObligations(db,config,p);expect(p.removed).toBe(0);expect(await warnings()).toBe(3);
});
it('confirmed absence resets warns and schedules reinvite after configured punishment',async()=>{
  await three();const p=provider();await tickObligations(db,config,p);expect(p.removed).toBe(1);expect(await warnings()).toBe(0);
  const rows=await obligations();expect(rows.map(r=>r.status)).toEqual(['done','pending']);
  const times=(await db.query<{attempted_at:Date;due_at:Date}>("SELECT k.attempted_at,r.due_at FROM obligations k JOIN obligations r ON r.ref=k.ref AND r.kind='roulette_reinvite' WHERE k.kind='roulette_kick'")).rows[0]!;
  expect(+times.due_at-+times.attempted_at).toBe(60000);
  await tickObligations(db,config,p);expect(p.removed).toBe(1);expect((await db.query("SELECT * FROM outbox WHERE kind='roulette_reinvite'")).rowCount).toBe(0);
});
it('expired punishment queues private invitation even though expelled member lost private autoapproval',async()=>{
  await three();const p=provider();await tickObligations(db,config,p);await due();await tickObligations(db,config,p);
  const row=(await db.query<{chat_id:string;payload:{text:string};status:string}>("SELECT * FROM outbox WHERE kind='roulette_reinvite'")).rows[0]!;
  expect(row.chat_id).toBe(member);expect(row.status).toBe('queued');expect(row.payload.text).toContain('chat.whatsapp.com/');
  expect((await obligations())[1]?.status).toBe('queued');
  // Finish notification first, then the private delivery, with real outbox state transitions.
  const mock=new MockEvolution();for(let i=0;i<3;i++){await db.query('UPDATE outbox SET sending_at=NULL');await sendNext(db,mock,config);}
  await tickObligations(db,config,p);expect((await obligations())[1]?.status).toBe('done');
  await tickObligations(db,config,p);expect((await db.query("SELECT * FROM outbox WHERE kind='roulette_reinvite'")).rowCount).toBe(1);
});
it('rate-limit rejection retries safely without repeating a successful kick',async()=>{
  await three();const p=provider();p.outcome='retry';await tickObligations(db,config,p);expect((await obligations())[0]?.status).toBe('pending');expect(await warnings()).toBe(3);
  p.outcome='accepted';await due();await tickObligations(db,config,p);await due();await tickObligations(db,config,p);expect(p.removed).toBe(2);expect(await warnings()).toBe(0);
});
it('retry limit preserves unresolved obligation for review and alerts owner',async()=>{
  await three();const p=provider();p.outcome='retry';for(let i=0;i<3;i++){await due();await tickObligations(db,config,p);}expect(p.removed).toBe(3);expect((await obligations())[0]?.status).toBe('review');expect(await warnings()).toBe(3);
});
it('HTTP acceptance alone never proves removal',async()=>{
  await three();const p=provider();p.remove=async()=>{p.removed++;return 'accepted';};await tickObligations(db,config,p);
  expect((await obligations())[0]?.status).toBe('review');expect(await obligations()).toHaveLength(1);expect(await warnings()).toBe(3);
});
it('crash after successful kick is recovered from persisted sending state and fresh roster',async()=>{
  await three();const p=provider();p.failAfter=true;await tickObligations(db,config,p);expect((await obligations())[0]?.status).toBe('sending');
  p.failAfter=false;await due();await tickObligations(db,config,p);expect(p.removed).toBe(1);expect((await obligations()).map(r=>r.status)).toEqual(['done','pending']);
});
it('ambiguous attempt with person present never kicks them again after restart',async()=>{
  await three();const p=provider();await db.query("UPDATE obligations SET status='sending',attempted_at=now(),attempts=1");await tickObligations(db,config,p);
  expect(p.removed).toBe(0);expect((await obligations())[0]?.status).toBe('review');expect(await warnings()).toBe(3);
});
it('lost admin permission prevents kick and retains obligation',async()=>{
  await three();const p=provider();p.data.participants.find(m=>m.id==='200@s.whatsapp.net')!.admin=null;await tickObligations(db,config,p);
  expect(p.removed).toBe(0);expect((await obligations())[0]?.status).toBe('pending');expect(await warnings()).toBe(3);
});
it('invitation failure retries, persists failure and alerts owner',async()=>{
  await three();const p=provider();await tickObligations(db,config,p);p.failInvite=true;
  for(let i=0;i<3;i++){await due();await tickObligations(db,config,p);}expect((await obligations())[1]?.status).toBe('review');expect((await db.query("SELECT * FROM error_log WHERE where_='roulette.obligation'")).rowCount).toBe(3);
});
it('uncertain private invitation is kept for reconciliation and never called sent',async()=>{
  await three();const p=provider();await tickObligations(db,config,p);await due();await tickObligations(db,config,p);
  await db.query("UPDATE outbox SET status='sending' WHERE kind='roulette_reinvite'");await recoverSending(db);await tickObligations(db,config,p);expect((await obligations())[1]?.status).toBe('queued');
  await db.query("UPDATE outbox SET reconcile_attempts=3 WHERE kind='roulette_reinvite'");await tickObligations(db,config,p);expect((await obligations())[1]?.status).toBe('review');
});
it('rejected removal leaves warns intact and creates no reinvite',async()=>{
  await three();const p=provider();p.outcome='rejected';await tickObligations(db,config,p);expect(await warnings()).toBe(3);expect(await obligations()).toHaveLength(1);expect((await obligations())[0]?.status).toBe('review');
});
it('already absent before a first attempt is skipped without claiming an expulsion',async()=>{
  await three();const p=provider();p.data.participants=p.data.participants.filter(m=>m.id!==member);await tickObligations(db,config,p);expect(p.removed).toBe(0);expect(await warnings()).toBe(3);expect(await obligations()).toHaveLength(1);
});
it('emergency stops effects; reactivation resumes persisted obligations',async()=>{
  await three();const p=provider();await execute('control.emergency');await tickObligations(db,config,p);expect(p.removed).toBe(0);await execute('control.reactivate');await tickObligations(db,config,p);expect(p.removed).toBe(1);
});
it('disabling games skips a new kick but keeps an existing return obligation',async()=>{
  await three();const p=provider();await tickObligations(db,config,p);await execute('control.modules',{module:'games',enabled:false});await due();await tickObligations(db,config,p);expect((await obligations())[1]?.status).toBe('queued');
});
it('additional warns cannot schedule duplicate active expulsions',async()=>{
  await three();for(let i=4;i<=6;i++)await transaction(db,c=>rouletteWarn(c,config.LAB_CHAT_ID,member,`game${i}`,1));expect(await obligations()).toHaveLength(1);expect(await warnings()).toBe(6);
});
it('removing warns before the kick cancels its eligibility',async()=>{
  await three();await transaction(db,c=>changeWarn(c,config.LAB_CHAT_ID,member,admin,'remove',true));const p=provider();await tickObligations(db,config,p);expect(p.removed).toBe(0);expect((await obligations())[0]?.status).toBe('skipped');
});
