import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { db,config,owner,admin,member,initialize,resetSchool,context,message,command,execute,proposal,seedSchedule } from './school-harness.js';
import { route } from '../src/core/router.js';
import { createRegistry } from '../src/core/registry.js';
import { receive,processNext } from '../src/core/inbox.js';
import { moduleEnabled } from '../src/core/permissions.js';
import { argumentHash } from '../src/core/sessions.js';
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
it('allows owner/admin subject management and members only reading, creation and own edits',async()=>{
  expect((await execute('school.subject_save',{name:'Matemáticas'},member)).ok).toBe(false);
  expect((await execute('school.subject_save',{name:'Matemáticas'},admin)).ok).toBe(true);
  const id=(await db.query('SELECT id FROM school_subjects')).rows[0]!.id as string;
  expect((await execute('school.subject_save',{id,name:'Matemáticas II'},owner)).ok).toBe(true);
  expect((await execute('school.subjects',{},member)).ok).toBe(true);
  expect(await command('bot ayuda escuela',member)).not.toContain('school.task_delete');
  expect(await command('bot ayuda escuela',admin)).toContain('school.task_delete');
  expect(await command('bot ayuda escuela',member)).not.toContain('school.schedule_propose');
});
it('never persists a schedule before the explicit authorized confirmation and survives a fresh registry',async()=>{
  const output=await execute('school.schedule_propose',proposal,admin);
  expect(output.ok && output.reply).toContain('lunes 08:00–09:00: Matemáticas');
  expect(output.ok && output.reply).toContain('viernes 11:00–12:00: Historia');
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
  expect((await db.query('SELECT * FROM school_subjects')).rowCount).toBe(0);
  expect(await command('sí',member)).toBeUndefined();
  expect(await command(message('sí',admin,'100@s.whatsapp.net'))).toContain('No tienes');
  expect(await command('sí',admin)).toContain('Guardé el horario');
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(2);
  expect(await command('sí',admin)).toBeUndefined();
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(2);
});
it.each(['cancel','expiry','module disabled','admin revoked','args tampered','preview tampered'])('rejects schedule confirmation after %s',async kind=>{
  await execute('school.schedule_propose',proposal,admin);
  if(kind==='cancel')await command('no',admin);
  if(kind==='expiry')await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  if(kind==='module disabled')await command('bot desactiva escuela aquí');
  if(kind==='admin revoked')await db.query('UPDATE group_memberships SET is_admin=false');
  if(kind==='args tampered')await db.query("UPDATE sessions SET state=jsonb_set(state,'{args,previewHash}',to_jsonb(repeat('a',64)))");
  if(kind==='preview tampered')await db.query("UPDATE school_imports SET preview=jsonb_set(preview,'{lessons,0,subject}','\"Falso\"')");
  await command('sí',admin);
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
});
it('rejects direct/model commit bypasses and actor/chat arguments supplied by Gemini',async()=>{
  await execute('school.schedule_propose',proposal);
  const draft=(await db.query<{id:string;args_hash:string}>('SELECT id,args_hash FROM school_imports')).rows[0]!;
  const args={importId:draft.id,previewHash:draft.args_hash};
  expect((await execute('school.schedule_commit',args)).ok).toBe(false);
  expect((await context(message('x'),ctx=>createRegistry().execute(ctx,'school.schedule_commit',args,'model'))).ok).toBe(false);
  for(const extra of [{actor:owner},{chatId:'400@g.us'},{created_by:owner}])expect((await execute('school.task_create',{subject:'Matemáticas',title:'x',...extra},member)).ok).toBe(false);
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
});
it('rejects stale previews after another administrator changes the schedule or subjects',async()=>{
  await execute('school.schedule_propose',proposal,admin);
  await execute('school.subject_save',{name:'Física'});
  expect(await command('sí',admin)).toContain('Otro administrador');
  expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
});
it('requires valid membership, local admin evidence and group/module scope even at execution',async()=>{
  expect((await execute('school.subjects',{},'700@s.whatsapp.net')).ok).toBe(false);
  await db.query("UPDATE group_memberships SET last_seen_at=now()-interval '10 minutes' WHERE user_id=$1",[member]);
  expect((await execute('school.subjects',{},member)).ok).toBe(false);
  await db.query("UPDATE chats SET settings='{\"modules\":{\"school\":true}}' WHERE id='400@g.us'");
  expect((await execute('school.subject_save',{name:'x'},admin,'400@g.us')).ok).toBe(false);
  expect((await execute('school.subjects',{},owner,'100@s.whatsapp.net')).ok).toBe(false);
  expect(moduleEnabled({id:'400@g.us',isGroup:true,enabled:true,settings:{}},'school',config)).toBe(false);
  await command('bot desactiva escuela aquí');
  expect((await execute('school.subject_save',{name:'x'})).ok).toBe(false);
});
it('creates tasks as a member with backend attribution, next-class fallback and no-date fallback',async()=>{
  await seedSchedule();await execute('school.subject_save',{name:'Física'});
  expect(await command('bot tarea Matemáticas | ejercicios 1 al 5',member)).toContain('(próxima clase)');
  expect(await command('bot tarea Física | proyecto',member)).toContain('sin fecha de entrega');
  const rows=(await db.query<{created_by:string;due_source:string|null;due_at:Date|null}>('SELECT created_by,due_source,due_at FROM school_tasks ORDER BY id')).rows;
  expect(rows.map(r=>r.created_by)).toEqual([member,member]);expect(rows[0]!.due_source).toBe('next_class');expect(rows[1]!.due_at).toBeNull();
  expect((await db.query('SELECT * FROM llm_usage')).rowCount).toBe(0);
});
it('validates due dates, refuses unknown subjects, and supports author-only edits and admin logical deletion',async()=>{
  await seedSchedule();
  expect((await execute('school.task_create',{subject:'Desconocida',title:'x'},member)).ok).toBe(false);
  for(const dueAt of ['2020-01-01T08:00:00-06:00','2030-01-01T08:00:00'])expect((await execute('school.task_create',{subject:'Matemáticas',title:'x',dueAt},member)).ok).toBe(false);
  await execute('school.task_create',{subject:'Matemáticas',title:'Proyecto',dueAt:'2030-01-01T08:00:00-06:00'},member);
  const id=(await db.query('SELECT id FROM school_tasks')).rows[0]!.id as string;
  expect((await execute('school.task_edit',{id,title:'Cambió'},'700@s.whatsapp.net')).ok).toBe(false);
  await db.query("INSERT INTO group_memberships(chat_id,user_id) VALUES('300@g.us','700@s.whatsapp.net')");
  expect((await execute('school.task_edit',{id,title:'Cambió'},'700@s.whatsapp.net')).ok).toBe(false);
  expect((await execute('school.task_edit',{id,title:'Corrección',dueAt:null},member)).ok).toBe(true);
  expect((await execute('school.task_edit',{id,title:'Admin corrigió'},admin)).ok).toBe(true);
  expect((await execute('school.task_delete',{id},member)).ok).toBe(false);
  expect(await command(`bot tarea borra ${id}`,admin)).toContain('Confirma');
  expect((await db.query('SELECT deleted_at FROM school_tasks')).rows[0]?.deleted_at).toBeNull();
  expect(await command('sí',admin)).toContain('Eliminé');
  expect(await command('bot tareas',member)).toContain('No hay tareas');
});
it('isolates subjects, schedules, task queries, edits and deletion by the authenticated chat',async()=>{
  await seedSchedule();await execute('school.task_create',{subject:'Matemáticas',title:'Solo Lab'},member);
  const id=(await db.query('SELECT id FROM school_tasks')).rows[0]!.id as string;
  await db.query("UPDATE chats SET settings='{\"modules\":{\"school\":true}}' WHERE id='400@g.us'");
  const read=await execute('school.tasks',{},owner,'400@g.us');expect(read.ok && read.reply).not.toContain('Solo Lab');
  expect((await execute('school.task_edit',{id,title:'Intruso'},owner,'400@g.us')).ok).toBe(false);
  expect((await execute('school.subject_save',{name:'Matemáticas'},owner,'400@g.us')).ok).toBe(true);
  const deletion=await execute('school.task_delete',{id},owner,'400@g.us');expect(deletion.ok).toBe(true);
  await context(message('x',owner,'400@g.us'),ctx=>createRegistry().execute(ctx,'school.task_delete',{id},'confirmed'));
  expect((await db.query('SELECT deleted_at FROM school_tasks WHERE id=$1',[id])).rows[0]?.deleted_at).toBeNull();
});
it('dedupes a repeated webhook and repeated tool calls using the backend message identity',async()=>{
  await seedSchedule();const msg=message('bot tarea Matemáticas | única',member);
  await receive(db,config,msg);expect(await receive(db,config,msg)).toBe('duplicate');await processNext(db,config);await processNext(db,config);
  await context(msg,ctx=>createRegistry().execute(ctx,'school.task_create',{subject:'Historia',title:'duplicada'}));
  expect((await db.query('SELECT * FROM school_tasks')).rowCount).toBe(1);
});
it('handles natural-language tasks through validated tools, with no identity or chat in model input',async()=>{
  await seedSchedule();
  const generated=vi.fn(async(input:{contents:unknown[]})=>{
    const data=JSON.stringify(input);expect(data).not.toContain(member);expect(data).not.toContain(config.LAB_CHAT_ID);
    return {text:'',calls:[{name:'school_task_create',args:{subject:'Matemáticas',title:'Ejercicios del libro'}}],content:{}};
  });
  const output=await context(message('bot anota los ejercicios del libro para Matemáticas',member),ctx=>route(ctx,{generate:generated}));
  expect(output).toContain('Registré la tarea');expect((await db.query('SELECT created_by FROM school_tasks')).rows[0]?.created_by).toBe(member);
});
it('binds the confirmation digest to the stored preview rather than trusting JSON from the model',async()=>{
  await execute('school.schedule_propose',proposal);
  const row=(await db.query('SELECT preview,args_hash FROM school_imports')).rows[0]!;
  expect(row.args_hash).toBe(argumentHash('school.schedule',row.preview));
});
it('does not create a new subject from a malformed rename command or exceed limits by reactivation',async()=>{
  expect(await command('bot materia edita Matemáticas')).toContain('argumentos no son válidos');
  expect((await db.query('SELECT * FROM school_subjects')).rowCount).toBe(0);
  await execute('school.subject_save',{name:'Archivada'});
  const id=(await db.query('SELECT id FROM school_subjects')).rows[0]!.id as string;
  await db.query('UPDATE school_subjects SET active=false');
  await db.query("INSERT INTO school_subjects(chat_id,name) SELECT '300@g.us','Materia '||n FROM generate_series(1,30) n");
  expect((await execute('school.subject_save',{id,name:'Reactivada'})).ok).toBe(false);
  expect((await db.query('SELECT * FROM school_subjects WHERE active')).rowCount).toBe(30);
});
