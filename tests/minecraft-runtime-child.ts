// Real child process used only by the isolated database restart test.
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/client.js';
import { readConfig } from '../src/config.js';
import { tickMinecraft } from '../src/modules/minecraft/service.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe database');
const db=createDb(url);
const config=readConfig({ROUTER_MODE:'v1',GEMINI_API_KEY:'fixture-gemini-key',DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock',MINECRAFT_ENABLED:'true'});
await tickMinecraft(db,config,async()=>{
  process.stdout.write('sending-committed\n');
  await new Promise(()=>{setInterval(()=>{},1000);});
  throw new Error('Unreachable');
});
await db.end();
