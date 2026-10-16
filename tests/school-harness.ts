import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb,transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { actorFor,type Chat } from '../src/core/permissions.js';
import { receive,processNext } from '../src/core/inbox.js';
import { createRegistry } from '../src/core/registry.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe database');
export const db=createDb(url);
export const config=readConfig({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'});
export const owner='100@s.whatsapp.net',admin='500@s.whatsapp.net',member='600@s.whatsapp.net';
export const message=(text:string,senderId=owner,chatId=config.LAB_CHAT_ID):Msg=>({id:randomUUID(),chatId,senderId,isGroup:chatId.endsWith('@g.us'),ts:new Date(),text,fromMe:false,mentions:[],attachments:[]});
export async function initialize():Promise<void>{await migrate(db);}
export async function resetSchool():Promise<void>{
  await db.query('TRUNCATE library_items,library_blobs,library_syncs,library_events,inbox,seen_events,outbox,chats,users,user_aliases,group_memberships,system_flags,error_log,sessions,notes,reminders,user_memories,context_msgs,llm_usage,llm_cooldowns,audit_log CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true),('400@g.us',true,true),('100@s.whatsapp.net',false,true)");
  await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net'),('500@s.whatsapp.net'),('600@s.whatsapp.net'),('700@s.whatsapp.net')");
  await db.query("INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES('300@g.us','500@s.whatsapp.net',true),('400@g.us','500@s.whatsapp.net',false),('300@g.us','600@s.whatsapp.net',false)");
}
export async function context<T>(input:Msg,fn:(ctx:ToolCtx)=>Promise<T>,overrides:Partial<ToolCtx>={}):Promise<T>{
  return transaction(db,async c=>{
    const actor=await actorFor(c,input,config);
    const row=(await c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[input.chatId])).rows[0]!;
    return fn({actor,chat:{id:input.chatId,isGroup:input.isGroup,...row},msg:input,db,c,config,now:new Date(),search:async()=>'',...overrides});
  });
}
export async function execute(name:string,args:unknown={},sender=owner,chatId=config.LAB_CHAT_ID){
  return context(message('bot prueba',sender,chatId),ctx=>createRegistry().execute(ctx,name,args));
}
export async function command(input:string|Msg,sender=owner):Promise<string|undefined>{
  const msg=typeof input==='string'?message(input,sender):input;
  await receive(db,config,msg);await processNext(db,config);
  return (await db.query<{payload:{text:string}}>("SELECT payload FROM outbox WHERE payload->>'sourceId'=$1 AND kind='text'",[msg.id])).rows[0]?.payload.text;
}
export const proposal={lessons:[{subject:'Matemáticas',weekday:1,start:'08:00',end:'09:00'},{subject:'Historia',weekday:5,start:'11:00',end:'12:00'}]};
export async function seedSchedule():Promise<void>{await execute('school.schedule_propose',proposal);await command('sí');}
