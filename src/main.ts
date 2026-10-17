import { geminiKeyPool } from './core/gemini-key-pool.js';
import { readConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { makeApp } from './app.js';
import { startRuntime } from './core/runtime.js';
import { MockEvolution } from './wa/mock.js';
import { msgSchema } from './wa/types.js';
import { Evolution } from './wa/evolution.js';
import { normalizeMessage } from './wa/normalize.js';
import { syncEnabledGroups } from './core/membership.js';
import { startMembershipRefresh } from './core/membership-refresh.js';
const config=readConfig();
const db=createDb(config.DATABASE_URL);
await migrate(db);
await db.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true) ON CONFLICT DO NOTHING',[config.LAB_CHAT_ID]);
const transport=config.TRANSPORT==='evolution'?new Evolution(config):new MockEvolution();
async function refreshMembers():Promise<void>{
  if(transport instanceof Evolution)await syncEnabledGroups(db,id=>transport.participants(id));
}
const app=makeApp(db,config,transport,input=>config.TRANSPORT==='evolution'?normalizeMessage(input,config.INSTANCE):msgSchema.parse(input));
app.log.info({geminiKeys:geminiKeyPool(config).snapshot().configured,maxConcurrent:config.LLM_MAX_CONCURRENT_CALLS,routerCanaryChats:config.ROUTER_V1_1_CHAT_IDS?.length ?? 0,routerDefault:config.ROUTER_MODE},'Gemini pool and router configured');
const stopMembershipRefresh=await startMembershipRefresh(refreshMembers,app.log);
const stopRuntime=await startRuntime(db,transport,config,app.log);
await app.listen({host:'0.0.0.0',port:config.PORT});
let closing=false;
async function close():Promise<void> {
  if(closing)return;closing=true;
  stopMembershipRefresh();await app.close();await stopRuntime();await db.end();
}
process.on('SIGTERM',()=>{void close();});
process.on('SIGINT',()=>{void close();});
