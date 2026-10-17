import { recoverDrive,claimDrive,processDrive } from './modules/drive/worker.js';
import { advanceBulk } from './modules/messaging/worker.js';
import { recoverLibrarySync,scheduleSync,syncLibrary } from './modules/library/sync.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { product } from '../config/product.js';
import { recoverMedia,retainMedia,claimMedia,processMedia } from './modules/media/worker.js';
import { reportMediaDeliveries } from './modules/media/delivery.js';
import { cleanOrphanTemporaries } from './modules/media/process.js';
const config=readConfig();
const db=createDb(config.DATABASE_URL);
await migrate(db);
const lock=await db.connect();
const held=await lock.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('botsky-worker')) AS locked");
if (!held.rows[0]?.locked) throw new Error('Another worker is active');
lock.on('error',()=>process.exit(1));
await recoverMedia(db);await recoverLibrarySync(db);await recoverDrive(db);
await cleanOrphanTemporaries();
let stop=false;
process.on('SIGTERM',()=>{stop=true;});
process.on('SIGINT',()=>{stop=true;});
const bulk=(async()=>{while(!stop){try{await advanceBulk(db,config);}catch{console.error('Bulk dispatcher persistence failure');process.exitCode=1;stop=true;}await delay(product.bulkPollMs);}})();
const heartbeat=setInterval(()=>{void db.query('INSERT INTO worker_heartbeat(id) VALUES(true) ON CONFLICT(id) DO UPDATE SET at=now()').catch(()=>process.exit(1));},product.tickMs);
while (!stop) {
  try{
    await scheduleSync(db,config);
    if(await syncLibrary(db,config))continue;
    await retainMedia(db);await reportMediaDeliveries(db);
    const drive=await claimDrive(db);if(drive){await processDrive(db,config,drive);continue;}
    const job=await claimMedia(db);
    if(job)await processMedia(db,config,job);
    else await delay(product.tickMs);
  }catch{
    // A persistence failure must stop this worker. Startup recovery owns orphaned work.
    process.exitCode=1;stop=true;
  }
}
clearInterval(heartbeat);
await bulk;
await lock.query("SELECT pg_advisory_unlock(hashtext('botsky-worker'))");
lock.release();await db.end();
