import { tickPolls } from '../modules/polls/service.js';
import { settleOrders } from '../modules/packs/delivery.js';
import { tickCooperachas } from '../modules/packs/cooperacha.js';
import { tickRain } from '../modules/packs/rain.js';
import { recoverMinecraft,tickMinecraft } from '../modules/minecraft/service.js';
import { tickGames } from '../modules/games/tick.js';
import { tickObligations } from '../modules/moderation/obligations.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Transport } from '../wa/types.js';
import { processNext } from './inbox.js';
import { recoverSending, sendNext } from '../wa/outbox.js';
import { tickSchool } from '../modules/school/automation.js';
import { tickCore } from '../modules/reminders/tick.js';
import { product } from '../../config/product.js';
export async function startRuntime(db:Db, transport:Transport, config:Config, log:FastifyBaseLogger):Promise<()=>Promise<void>> {
  const lock=await db.connect();
  const held=await lock.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('botsky-app')) AS locked");
  if (!held.rows[0]?.locked) { lock.release(); throw new Error('Another app owns the runtime'); }
  let stopped=false;
  // A lost session releases the advisory lock: stop this process before another can send.
  lock.on('error',()=>process.exit(1));
  await recoverSending(db);
  await recoverMinecraft(db);
  const task=(async()=>{
    while(!stopped){
      try{if(!await processNext(db,config))await delay(product.pollMs);}
      catch{log.error({where:'inbox'},'Falló el procesamiento');await delay(product.tickMs);}
    }
  })();
  const sending=(async()=>{
    while(!stopped){
      try{if(!await sendNext(db,transport,config))await delay(product.pollMs);}
      catch{log.error({where:'outbox'},'Falló el envío');await delay(product.tickMs);}
    }
  })();
  const ticking=(async()=>{
    while(!stopped){
      try{await tickCore(db,config);await tickPolls(db,config);await tickSchool(db,config);await tickGames(db,config);await settleOrders(db,config);await tickCooperachas(db);await tickRain(db,config); }
      catch{log.error({where:'tick'},'Falló el ciclo de tiempo');}
      for(let elapsed=0;elapsed<product.tickMs && !stopped;elapsed+=product.pollMs)await delay(product.pollMs);
    }
  })();
  const obligations=(async()=>{
    while(!stopped){
      try{await tickObligations(db,config);}
      catch{log.error({where:'obligations'},'Falló la recuperación de obligaciones');}
      for(let elapsed=0;elapsed<product.tickMs && !stopped;elapsed+=product.pollMs)await delay(product.pollMs);
    }
  })();
  const minecraft=(async()=>{
    while(!stopped){
      try{await tickMinecraft(db,config);}
      catch{log.error({where:'minecraft'},'Falló el control de Minecraft');}
      for(let elapsed=0;elapsed<product.tickMs && !stopped;elapsed+=product.pollMs)await delay(product.pollMs);
    }
  })();
  return async()=>{stopped=true;await Promise.all([task,sending,ticking,obligations,minecraft]);await lock.query("SELECT pg_advisory_unlock(hashtext('botsky-app'))");lock.release();};
}
