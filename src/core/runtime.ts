import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Transport } from '../wa/types.js';
import { processNext } from './inbox.js';
import { recoverSending, sendNext } from '../wa/outbox.js';
import { product } from '../../config/product.js';
export async function startRuntime(db:Db, transport:Transport, config:Config, log:FastifyBaseLogger):Promise<()=>Promise<void>> {
  const lock=await db.connect();
  const held=await lock.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('botsky-app')) AS locked");
  if (!held.rows[0]?.locked) { lock.release(); throw new Error('Another app owns the runtime'); }
  let stopped=false;
  // A lost session releases the advisory lock: stop this process before another can send.
  lock.on('error',()=>process.exit(1));
  await recoverSending(db);
  const task=(async()=>{
    while (!stopped) {
      try {
        const processed=await processNext(db,config);
        const sent=await sendNext(db,transport,config);
        if (!processed && !sent) await delay(product.pollMs);
      } catch {
        log.error({where:'runtime'},'Falló el ciclo de procesamiento');
        await delay(product.tickMs);
      }
    }
  })();
  return async()=>{stopped=true;await task;await lock.query("SELECT pg_advisory_unlock(hashtext('botsky-app'))");lock.release();};
}
