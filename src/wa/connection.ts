import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { transaction,type Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Transport } from './types.js';
const state=z.strictObject({outageId:z.uuid(),downSince:z.iso.datetime()});
/** One serialized persisted transition and one outbox insertion share a transaction. */
export async function observeConnection(db:Db,config:Config,open:boolean,now=new Date()):Promise<void>{
  if(config.TRANSPORT!=='evolution')return;
  await transaction(db,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-evolution-state'))");
    const row=(await c.query<{value:unknown}>("SELECT value FROM system_flags WHERE key='evolution_outage'")).rows[0];
    if(!open){
      if(!row)await c.query("INSERT INTO system_flags(key,value) VALUES('evolution_outage',$1)",[JSON.stringify({outageId:randomUUID(),downSince:now.toISOString()})]);
      return;
    }
    if(!row)return;
    const outage=state.parse(row.value);
    const minutes=Math.max(1,Math.round((now.getTime()-Date.parse(outage.downSince))/60_000));
    // The deployment defines a primary owner; exactly one private notice per outage.
    const owner=config.OWNER_JIDS.find(id=>/^\d+@s\.whatsapp\.net$/.test(id));
    if(!owner)throw new Error('Recovery notice requires a canonical owner');
    await c.query(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[owner,JSON.stringify({text:`Evolution volvió a conectarse. Estuvo desconectado aproximadamente ${minutes} minuto(s).`,sourceId:''}),`alert:evolution-recovered:${outage.outageId}`]);
    await c.query("DELETE FROM system_flags WHERE key='evolution_outage'");
  });
}
export async function checkConnection(db:Db,config:Config,transport:Transport):Promise<boolean>{
  let open=false;
  try{open=await transport.state();}catch{open=false;}
  await observeConnection(db,config,open);
  return open;
}
