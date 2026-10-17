import { readConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { observeConnection } from '../src/wa/connection.js';
process.once('message',async(input:{url:string;open:boolean})=>{
  if(!/^\/botsky_test_\d{13}_[1-9]\d{0,9}$/.test(new URL(input.url).pathname))throw new Error('Isolated test database required');
  const config=readConfig({GEMINI_API_KEY:'fixture-gemini-key',DATABASE_URL:input.url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'});
  const db=createDb(input.url);
  await observeConnection(db,{...config,TRANSPORT:'evolution'},input.open);
  await db.end();process.send?.('persisted');
  // Parent terminates this real process to exercise a fresh runtime after SIGKILL.
  setInterval(()=>undefined,1000);
});
