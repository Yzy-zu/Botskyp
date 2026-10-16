import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { makeApp } from '../src/app.js';
import { startRuntime } from '../src/core/runtime.js';
import { msgSchema,type Transport,type Delivery,type SendResult,type ReconcileResult } from '../src/wa/types.js';
const input=JSON.parse(readFileSync('.local/library-runtime-test.json','utf8')) as NodeJS.ProcessEnv;
const config=readConfig(input);const db=createDb(config.DATABASE_URL);
const transport:Transport={
  async state(){return true;},
  async send(d:Delivery):Promise<SendResult>{
    await db.query(`INSERT INTO library_mock_deliveries(id,count) VALUES($1,1) ON CONFLICT(id) DO UPDATE SET count=library_mock_deliveries.count+1`,[d.id]);
    const pause=await db.query('SELECT pause FROM library_mock_control');
    if(pause.rows[0]?.pause)await delay(30_000);
    return {status:'sent',id:`mock-${d.id}`};
  },
  async reconcile(d:Delivery):Promise<ReconcileResult>{
    const r=await db.query('SELECT id FROM library_mock_deliveries WHERE id=$1',[d.id]);
    return r.rowCount ? {status:'found',id:`mock-${d.id}`} : {status:'absent'};
  },
};
const app=makeApp(db,config,transport,input=>msgSchema.parse(input));
const stop=await startRuntime(db,transport,config,app.log);
const address=await app.listen({host:'127.0.0.1',port:0});
process.stdout.write(`READY ${address}\n`);
process.on('SIGTERM',()=>{void(async()=>{await app.close();await stop();await db.end();})();});
