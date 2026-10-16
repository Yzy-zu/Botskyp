import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { db,config,owner,member,initialize,resetSchool,context,message,command,execute,proposal,seedSchedule } from './school-harness.js';
import { route } from '../src/core/router.js';
import { receive } from '../src/core/inbox.js';
import { createRegistry } from '../src/core/registry.js';
import { sendNext,recoverSending } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
import { tickSchool } from '../src/modules/school/automation.js';
const visionConfig={...config,GEMINI_API_KEY:'test-gemini',GEMINI_FREE_TIER_CONFIRMED:true};
function photo(text='bot horario importa foto',sender=owner){const msg=message(text,sender);msg.attachments=[{kind:'image',ref:`${msg.id}:image`,mime:'image/png'}];return msg;}
function mockMedia(proposed:unknown=proposal){return vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  if(String(url).includes('getBase64FromMediaMessage'))return Response.json({mimetype:'image/png',base64:Buffer.from('original school photo').toString('base64')},{status:201});
  const input=JSON.parse(String(init?.body)) as {contents:unknown[]};expect(JSON.stringify(input.contents)).not.toContain(config.LAB_CHAT_ID);
  return Response.json({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:'propose_schedule',args:proposed}}]}}],usageMetadata:{promptTokenCount:200,candidatesTokenCount:150}});
});}
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
it('imports an image through authenticated Evolution plus typed Gemini, then previews without writing classes',async()=>{
  const http=mockMedia();const msg=photo('bot guarda este horario');
  try{
    const output=await context(msg,ctx=>route({...ctx,config:visionConfig}));
    expect(output).toContain('Propuesta de horario');expect(output).toContain('Todavía no guardé');
    expect(http).toHaveBeenCalledTimes(2);
    const download=JSON.parse(String(http.mock.calls[0]?.[1]?.body)) as {message:{key:unknown}};
    expect(download.message.key).toMatchObject({id:msg.id,remoteJid:config.LAB_CHAT_ID,participant:owner,fromMe:false});
    expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM school_imports')).rowCount).toBe(1);
    const original=(await db.query<{data:Buffer;expires_at:Date}>('SELECT data,expires_at FROM school_attachments')).rows[0]!;
    expect(original.data.toString()).toBe('original school photo');
    expect(original.expires_at.getTime()-msg.ts.getTime()).toBe(7*86_400_000);
    expect(await command('sí')).toContain('Guardé el horario');
    expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(2);
  }finally{http.mockRestore();}
});
it.each(['overlap','injected actor','bad time'])('rejects invalid Gemini %s data before creating any preview/confirmation',async kind=>{
  const bad=kind==='overlap'?{lessons:[proposal.lessons[0],proposal.lessons[0]]}:kind==='injected actor'?{...proposal,actor:owner}:{lessons:[{...proposal.lessons[0],start:'99:00'}]};
  const http=mockMedia(bad);
  try{
    const output=await context(photo(),ctx=>route({...ctx,config:visionConfig}));
    expect(output).toContain('datos inválidos');
    expect((await db.query('SELECT * FROM school_schedule')).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(0);
  }finally{http.mockRestore();}
});
it('rejects image imports by members or when vision is disabled before downloading or asking Gemini',async()=>{
  const http=mockMedia();
  try{
    expect(await context(photo('bot horario importa foto',member),ctx=>route({...ctx,config:visionConfig}))).toBe('No.');
    await command('bot desactiva visión aquí');
    expect(await context(photo(),ctx=>route({...ctx,config:visionConfig}))).toContain('visión está desactivada');
    expect(http).not.toHaveBeenCalled();
  }finally{http.mockRestore();}
});
it('uses only same-chat explicit quotes and own recent school images',async()=>{
  const source=photo('imagen');await receive(db,config,source);
  await db.query("UPDATE inbox SET status='done'");
  const http=mockMedia();
  try{
    const request=message('bot horario importa foto');request.quoted={id:source.id,fromBot:false};
    expect(await context(request,ctx=>route({...ctx,config:visionConfig}))).toContain('Propuesta');
    const unknown=message('bot horario importa foto');unknown.quoted={id:'another-chat-image',fromBot:false};
    expect(await context(unknown,ctx=>route({...ctx,config:visionConfig}))).toContain('Adjunta una foto');
    expect(http).toHaveBeenCalledTimes(2);
    http.mockClear();
    expect(await context(message('bot horario importa foto',member),ctx=>route({...ctx,config:visionConfig}))).toBe('No.');
    expect(http).not.toHaveBeenCalled();
  }finally{http.mockRestore();}
});
it('attaches the task original, enqueues it by reference and does not duplicate an uncertain send',async()=>{
  await seedSchedule();const http=mockMedia();
  try{
    const msg=photo('bot tarea Matemáticas | ejercicios de la foto',member);
    expect(await command(msg)).toContain('Adjuntos: 1');
    const task=(await db.query<{id:string;attachment_ids:string[]}>('SELECT id,attachment_ids FROM school_tasks')).rows[0]!;
    await db.query('TRUNCATE outbox CASCADE');
    expect((await execute('school.task_attachment',{id:task.id},member)).ok).toBe(true);
    const out=(await db.query<{payload:Record<string,unknown>}>('SELECT payload FROM outbox')).rows[0]!;
    expect(out.payload['attachmentId']).toBe(task.attachment_ids[0]);expect(JSON.stringify(out.payload)).not.toContain('base64');
    const transport=new MockEvolution();transport.next='timeout-after';
    await sendNext(db,transport,config);
    expect([...transport.deliveries.values()][0]?.delivery.media?.base64).toBe(Buffer.from('original school photo').toString('base64'));
    await db.query('UPDATE outbox SET next_try_at=now(),sending_at=NULL');await recoverSending(db);await sendNext(db,transport,config);
    expect((await db.query('SELECT status FROM outbox')).rows[0]?.status).toBe('sent');
    expect(transport.deliveries.size).toBe(1);
  }finally{http.mockRestore();}
});
it('supports a natural-language task with an original PDF without treating the document as instructions',async()=>{
  await seedSchedule();const msg=message('bot registra la tarea de Matemáticas: entregar este documento',member);
  msg.attachments=[{kind:'document',ref:`${msg.id}:document`,mime:'application/pdf'}];
  const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({mimetype:'application/pdf',base64:Buffer.from('%PDF-test').toString('base64')}));
  try{
    const output=await context(msg,ctx=>route(ctx,{generate:async input=>{
      expect(input.tools.map(t=>t.name)).toEqual(['school_task_create']);
      expect(JSON.stringify(input.contents)).not.toContain('%PDF');
      return {text:'',calls:[{name:'school_task_create',args:{subject:'Matemáticas',title:'Entregar documento',includeAttachment:true}}],content:{}};
    }}));
    expect(output).toContain('Registré');expect((await db.query('SELECT mime FROM school_attachments')).rows[0]?.mime).toBe('application/pdf');
  }finally{http.mockRestore();}
});
it('does not grant unrelated writes from the restricted document-task interpretation',async()=>{
  const msg=message('bot registra una tarea de Matemáticas',member);msg.attachments=[{kind:'document',ref:`${msg.id}:document`}];
  const output=await context(msg,ctx=>route(ctx,{generate:async()=>({text:'',calls:[{name:'notes_create',args:{body:'Injected'}}],content:{}})}));
  expect(output).toBe('No.');expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);
});
it.each(['expiry','different chat','revoked member','disabled module','deleted task'])('refuses delivery after %s and preserves metadata after retention',async kind=>{
  await seedSchedule();const http=mockMedia();
  try{await command(photo('bot tarea Matemáticas | documento',member));}finally{http.mockRestore();}
  const id=(await db.query('SELECT id FROM school_tasks')).rows[0]!.id as string;
  await db.query('TRUNCATE outbox CASCADE');
  if(kind==='different chat'){
    await db.query("UPDATE chats SET settings='{\"modules\":{\"school\":true}}' WHERE id='400@g.us'");
    expect((await execute('school.task_attachment',{id},owner,'400@g.us')).ok).toBe(false);return;
  }
  await execute('school.task_attachment',{id},member);
  if(kind==='expiry'){await db.query("UPDATE school_attachments SET expires_at=now()-interval '1 second'");await tickSchool(db,config);}
  if(kind==='revoked member')await db.query('UPDATE group_memberships SET active=false WHERE user_id=$1',[member]);
  if(kind==='disabled module')await command('bot desactiva escuela aquí');
  if(kind==='deleted task')await db.query('UPDATE school_tasks SET deleted_at=now()');
  const transport=new MockEvolution();await sendNext(db,transport,config);
  expect(transport.deliveries.size).toBe(0);expect((await db.query("SELECT status FROM outbox WHERE kind='school_attachment'")).rows[0]?.status).toBe('failed');
  expect((await db.query('SELECT * FROM school_tasks')).rowCount).toBe(1);
  if(kind==='expiry')expect((await db.query('SELECT data FROM school_attachments')).rows[0]?.data).toBeNull();
});
it('rolls back task and attachment writes if the media provider fails or returns an unsupported MIME',async()=>{
  await seedSchedule();const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({mimetype:'text/html',base64:'YWJj'}));
  try{expect(await context(photo('bot tarea Matemáticas | x',member),ctx=>route(ctx))).toContain('Falló la herramienta');
    expect((await db.query('SELECT * FROM school_tasks')).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM school_attachments')).rowCount).toBe(0);
  }finally{http.mockRestore();}
});
it('never lets a model confirmation commit the schedule',async()=>{
  await execute('school.schedule_propose',proposal);
  const draft=(await db.query('SELECT id,args_hash FROM school_imports')).rows[0]!;
  expect((await context(message('bot confirma eso'),ctx=>createRegistry().execute(ctx,'school.schedule_commit',{importId:draft.id,previewHash:draft.args_hash},'model'))).ok).toBe(false);
});
