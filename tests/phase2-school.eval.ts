/** Explicit live Gemini check, synthetic image, isolated database, no WhatsApp sends. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import setup from './setup.js';
import { createDb,transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { route } from '../src/core/router.js';
import { createRegistry } from '../src/core/registry.js';
import { schoolZone,type Schedule } from '../src/modules/school/schemas.js';
import type { Msg } from '../src/wa/types.js';
assert(process.argv[2],'Usage: npm run eval:phase2 -- /private/path/synthetic-school-schedule.png');
const bytes=readFileSync(process.argv[2]);
const cleanup=await setup();
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
const db=createDb(url),realFetch=globalThis.fetch;
const statuses:number[]=[];let preview:string|undefined;let ms=0;
try{
  await migrate(db);
  const config=readConfig({...process.env,DATABASE_URL:url,TRANSPORT:'mock',EVOLUTION_URL:'http://mock',OWNER_JIDS:'100@s.whatsapp.net',LAB_CHAT_ID:'300@g.us'});
  const actor={id:'100@s.whatsapp.net',role:'owner' as const};
  const chat={id:'300@g.us',isGroup:true,enabled:true,settings:{}};
  await db.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true)',[chat.id]);
  const id=randomUUID();
  const msg:Msg={id,chatId:chat.id,senderId:actor.id,isGroup:true,ts:new Date(),text:'bot horario importa foto',fromMe:false,mentions:[],attachments:[{kind:'image',ref:`${id}:image`,mime:'image/png'}]};
  globalThis.fetch=async(input,init)=>{
    if(String(input).startsWith(config.EVOLUTION_URL)){
      const body=JSON.parse(String(init?.body)) as {message:{key:{id:string;remoteJid:string}}};
      assert.equal(body.message.key.id,id);assert.equal(body.message.key.remoteJid,chat.id);
      return Response.json({mimetype:'image/png',base64:bytes.toString('base64')},{status:201});
    }
    const response=await realFetch(input,init);statuses.push(response.status);return response;
  };
  const start=performance.now();
  preview=await transaction(db,async c=>route({actor,chat,msg,db,c,config,now:new Date(),search:async()=>''}));
  ms=Math.round(performance.now()-start);
  assert.match(preview ?? '',/Propuesta de horario semanal/);
  assert.equal((await db.query('SELECT * FROM school_schedule')).rowCount,0);
  const proposal=(await db.query<{preview:Schedule}>('SELECT preview FROM school_imports')).rows[0]!.preview;
  assert.deepEqual(proposal.lessons.map(l=>({weekday:l.weekday,start:l.start,end:l.end})).sort((a,b)=>a.weekday-b.weekday),[
    {weekday:1,start:'08:00',end:'09:00'},{weekday:3,start:'10:00',end:'11:00'},{weekday:5,start:'12:00',end:'13:00'},
  ]);
  assert.match(proposal.lessons.map(l=>l.subject).join(' '),/matem[aá]ticas/iu);
  assert.match(proposal.lessons.map(l=>l.subject).join(' '),/historia/iu);
  assert.match(proposal.lessons.map(l=>l.subject).join(' '),/f[ií]sica/iu);
  const confirmed=await transaction(db,async c=>route({actor,chat,msg:{...msg,id:randomUUID(),text:'sí',attachments:[]},db,c,config,now:new Date(),search:async()=>''}));
  assert.match(confirmed ?? '',/Guardé el horario/);
  assert.equal((await db.query('SELECT * FROM school_schedule')).rowCount,3);
  assert.equal((await db.query('SELECT * FROM outbox')).rowCount,0);
  const declarationChars=await transaction(db,async c=>JSON.stringify(createRegistry().declarations({actor,chat,msg,db,c,config,now:new Date(),search:async()=>''})).length);
  const usage=(await db.query('SELECT status,purpose,input_tokens,output_tokens FROM llm_usage ORDER BY id')).rows;
  const evidence={at:new Date().toISOString(),passed:true,source:'synthetic school table, not a real WhatsApp photo',timezone:schoolZone,ms,preview,confirmed,statuses,usage,declarationChars,whatsAppMessages:0};
  writeFileSync('.local/phase2-school-eval.json',JSON.stringify(evidence),{mode:0o600});
  console.log(JSON.stringify({...evidence,preview:undefined,confirmed:undefined}));
}catch(error){
  writeFileSync('.local/phase2-school-eval.json',JSON.stringify({at:new Date().toISOString(),passed:false,ms,preview,statuses}),{mode:0o600});
  console.error(error instanceof assert.AssertionError?error.message:'Live school evaluation failed; evidence is private.');process.exitCode=1;
}finally{globalThis.fetch=realFetch;await db.end();await cleanup();}
