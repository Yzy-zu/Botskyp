import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { makeApp } from '../src/app.js';
import { startRuntime } from '../src/core/runtime.js';
import { advanceBulk } from '../src/modules/messaging/worker.js';
import { claimDrive,processDrive } from '../src/modules/drive/worker.js';
import { DriveClient } from '../src/modules/drive/client.js';
import { driveConfigSchema } from '../src/modules/drive/config.js';
import { msgSchema,type Transport } from '../src/wa/types.js';
const input=JSON.parse(readFileSync('.local/messaging-runtime-test.json','utf8')) as {env:NodeJS.ProcessEnv;mode:string};
const config=readConfig({GEMINI_API_KEY:'fixture-gemini-key',...input.env});const db=createDb(config.DATABASE_URL);
if(!new URL(config.DATABASE_URL).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
const transport:Transport={
  async state(){return true;},
  async send(d){
    if(d.requireReceipt){
      await db.query('INSERT INTO messaging_mock_deliveries(id,count) VALUES($1,1) ON CONFLICT(id) DO UPDATE SET count=messaging_mock_deliveries.count+1',[d.id]);
      if((await db.query('SELECT pause FROM messaging_mock_control')).rows[0]?.pause)await delay(30_000);
    }
    return {status:'sent',id:`mock-${d.id}`};
  },
  async reconcile(d){const exists=await db.query('SELECT 1 FROM messaging_mock_deliveries WHERE id=$1',[d.id]);return exists.rowCount?{status:'found',id:`mock-${d.id}`}:{status:'absent'};},
};
if(input.mode==='bulk'){
  const app=makeApp(db,config,transport,value=>msgSchema.parse(value));await startRuntime(db,transport,config,app.log);
  await app.listen({host:'127.0.0.1',port:0});
  process.stdout.write('READY\n');
  while(true){await advanceBulk(db,config);await delay(100);}
}else{
  const credentials=driveConfigSchema.parse({clientId:'test',clientSecret:'test',refreshToken:'test',ownerEmail:'owner@example.org',folders:{[config.LAB_CHAT_ID]:'folder_allowed_123'},recipients:{[config.OWNER_JIDS[0]! ]:'owner@example.org'}});
  const client=new DriveClient(credentials,async(url,init)=>{
    const u=new URL(String(url));
    if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'test'});
    if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['remote_uploaded_123']});
    if(u.pathname.startsWith('/upload/')){await db.query("INSERT INTO messaging_mock_deliveries(id,count) VALUES('drive-upload',1)");await delay(30_000);throw new Error('lost_response');}
    if(u.pathname.endsWith('/permissions'))return Response.json({permissions:[{type:'user',role:'owner',emailAddress:'owner@example.org'}]});
    if(init?.method)throw new Error('Unexpected write');
    return Response.json({id:'folder_allowed_123',name:'Private',mimeType:'application/vnd.google-apps.folder',ownedByMe:true});
  });
  process.stdout.write('READY\n');
  const job=await claimDrive(db);if(!job)throw new Error('Missing Drive job');
  await processDrive(db,config,job,{client:async()=>client,attachment:async()=>({bytes:Buffer.from('Hola'),mime:'text/plain'})});
}
