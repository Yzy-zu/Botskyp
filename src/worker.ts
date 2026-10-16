import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.js';
import { createDb, transaction } from './db/client.js';
import { migrate } from './db/migrate.js';
import { product } from '../config/product.js';
const config=readConfig();
const db=createDb(config.DATABASE_URL);
await migrate(db);
const lock=await db.connect();
const held=await lock.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('botsky-worker')) AS locked");
if (!held.rows[0]?.locked) throw new Error('Another worker is active');
lock.on('error',()=>process.exit(1));
await db.query("UPDATE jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error='interrupted' WHERE status='running'");
let stop=false;
process.on('SIGTERM',()=>{stop=true;});
process.on('SIGINT',()=>{stop=true;});
while (!stop) {
  await db.query('INSERT INTO worker_heartbeat(id) VALUES(true) ON CONFLICT(id) DO UPDATE SET at=now()');
  // No heavy job kinds are enabled in Phase 0. Reject unknown work explicitly.
  await transaction(db, async c=>{
    const jobs=await c.query<{id:string}>("SELECT id FROM jobs WHERE status='queued' AND run_after<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
    const job=jobs.rows[0];
    if (job) await c.query("UPDATE jobs SET status='failed',attempts=attempts+1,error='unsupported_kind_phase0' WHERE id=$1",[job.id]);
  });
  await delay(product.tickMs);
}
await lock.query("SELECT pg_advisory_unlock(hashtext('botsky-worker'))");
lock.release();await db.end();
