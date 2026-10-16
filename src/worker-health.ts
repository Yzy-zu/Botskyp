import { createDb } from './db/client.js';
const db=createDb(process.env.DATABASE_URL ?? '');
try {
  const r=await db.query("SELECT id FROM worker_heartbeat WHERE at>now()-interval '30 seconds'");
  process.exitCode=r.rowCount ? 0:1;
} catch {process.exitCode=1;} finally {await db.end();}
