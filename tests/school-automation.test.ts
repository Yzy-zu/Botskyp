import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { db,config,admin,member,initialize,resetSchool,execute,command,seedSchedule } from './school-harness.js';
import { tickSchool } from '../src/modules/school/automation.js';
import { sendNext } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
const schedule={days:[1,2,3,4,5],time:'07:00'};
async function due(sender=admin){
  const configured=await execute('school.summary_configure',{enabled:true,schedule},sender);expect(configured.ok).toBe(true);
  await db.query("UPDATE automations SET next_run_at=now()-interval '3 days'");
}
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
it('keeps the summary off by default and restricts schedule and destination configuration',async()=>{
  await tickSchool(db,config);expect((await db.query('SELECT * FROM automations')).rowCount).toBe(0);
  expect((await execute('school.summary_configure',{enabled:true,schedule},member)).ok).toBe(false);
  expect((await execute('school.summary_configure',{enabled:true})).ok).toBe(false);
  expect((await execute('school.destination',{targetGroupId:'400@g.us'})).ok).toBe(false);
  expect((await execute('school.destination',{})).ok).toBe(true);
  expect(await command('bot escuela resumen 07:00 lunes,martes,miércoles,jueves,viernes')).toContain('07:00');
  expect(await command('bot escuela configuración',member)).toContain('America/Mexico_City');
});
it('claims once during concurrent ticks and condenses missed summaries into a single delayed delivery',async()=>{
  await seedSchedule();await execute('school.task_create',{subject:'Historia',title:'Libro'},member);await db.query('TRUNCATE outbox CASCADE');
  await due();await Promise.all([tickSchool(db,config),tickSchool(db,config)]);await tickSchool(db,config);
  const rows=(await db.query<{payload:{text:string}}>("SELECT payload FROM outbox WHERE kind='school_summary'")).rows;
  expect(rows).toHaveLength(1);expect(rows[0]!.payload.text).toContain('retraso');expect(rows[0]!.payload.text).toContain('Libro');
  const transport=new MockEvolution();await sendNext(db,transport,config);await tickSchool(db,config);await tickSchool(db,config);
  expect(transport.deliveries.size).toBe(1);
  const automation=(await db.query<{next_run_at:Date;last_run_at:Date;outbox_id:string|null}>('SELECT * FROM automations')).rows[0]!;
  expect(automation.next_run_at.getTime()).toBeGreaterThan(Date.now());expect(automation.last_run_at).toBeInstanceOf(Date);expect(automation.outbox_id).toBeNull();
});
it('preserves uncertain summary delivery without scheduling or sending duplicates',async()=>{
  await due();await tickSchool(db,config);
  const transport=new MockEvolution();transport.next='timeout-after';await sendNext(db,transport,config);
  await tickSchool(db,config);await tickSchool(db,config);
  expect((await db.query("SELECT * FROM outbox WHERE kind='school_summary'")).rowCount).toBe(1);
  expect((await db.query('SELECT outbox_id FROM automations')).rows[0]?.outbox_id).not.toBeNull();
  await db.query('UPDATE outbox SET next_try_at=now(),sending_at=NULL');await sendNext(db,transport,config);await tickSchool(db,config);
  expect(transport.deliveries.size).toBe(1);expect((await db.query('SELECT outbox_id FROM automations')).rows[0]?.outbox_id).toBeNull();
});
it.each(['admin revoked','membership expired','module off','chat disabled','emergency','maintenance','summary off'])('checks %s before a scheduled effect',async kind=>{
  await due();
  if(kind==='admin revoked')await db.query('UPDATE group_memberships SET is_admin=false WHERE user_id=$1',[admin]);
  if(kind==='membership expired')await db.query("UPDATE group_memberships SET last_seen_at=now()-interval '1 hour' WHERE user_id=$1",[admin]);
  if(kind==='module off')await command('bot desactiva escuela aquí');
  if(kind==='chat disabled')await db.query('UPDATE chats SET enabled=false');
  if(kind==='emergency')await command('bot apagado de emergencia');
  if(kind==='maintenance')await command('bot mantenimiento on');
  if(kind==='summary off')await command('bot escuela resumen off');
  await tickSchool(db,config);
  expect((await db.query("SELECT * FROM outbox WHERE kind='school_summary'")).rowCount).toBe(0);
});
it('revalidates admin authority after queueing but before crossing the transport boundary',async()=>{
  await due();await tickSchool(db,config);await db.query('UPDATE group_memberships SET is_admin=false');
  const transport=new MockEvolution();await sendNext(db,transport,config);
  expect(transport.deliveries.size).toBe(0);expect((await db.query('SELECT status FROM outbox')).rows[0]?.status).toBe('failed');
  expect((await db.query("SELECT * FROM error_log WHERE where_='school.delivery'")).rowCount).toBe(1);
});
it('reconfiguring a summary preserves its in-flight delivery and avoids a second occurrence',async()=>{
  await due();await tickSchool(db,config);
  await execute('school.summary_configure',{enabled:true,schedule:{days:[1],time:'08:00'}},admin);
  const transport=new MockEvolution();await sendNext(db,transport,config);await tickSchool(db,config);
  expect((await db.query("SELECT * FROM outbox WHERE kind='school_summary'")).rowCount).toBe(1);
  expect((await db.query('SELECT config FROM automations')).rows[0]?.config).toEqual({days:[1],time:'08:00'});
  expect(transport.deliveries.size).toBe(1);
});
