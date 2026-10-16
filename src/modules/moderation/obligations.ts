import { z } from 'zod';
import { product } from '../../../config/product.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { moduleEnabled,type Chat } from '../../core/permissions.js';
import { botAdmin,EvolutionGroups,findMember,type GroupControl } from '../../wa/group-control.js';
import { enqueue } from '../games/state.js';
import { warnCount } from './service.js';
type Obligation={id:string;kind:'roulette_kick'|'roulette_reinvite';chat_id:string;user_id:string;ref:string;status:string;attempts:number;attempted_at:Date|null;detail:{punishmentMinutes:number};outbox_id:string|null};
async function alert(db:Db,config:Config,row:Obligation,reason:string):Promise<void>{
  await transaction(db,async c=>{
    await c.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('roulette.obligation',$1,$2)",[row.id,reason]);
    for(const owner of config.OWNER_JIDS)await enqueue(c,owner,`alert:obligation:${row.id}:${owner}`,`Obligación de ruleta #${row.id}: ${reason}. Revisa el estado; no se confirma un efecto desconocido.`);
  });
}
async function confirmedKick(db:Db,row:Obligation):Promise<void>{
  await transaction(db,async c=>{
    const claimed=await c.query("UPDATE obligations SET status='done' WHERE id=$1 AND status='sending' RETURNING id",[row.id]);
    if(!claimed.rowCount)return;
    await warnCount(c,row.chat_id,row.user_id);
    await c.query('UPDATE moderation_counts SET warns=0 WHERE chat_id=$1 AND user_id=$2',[row.chat_id,row.user_id]);
    await c.query("INSERT INTO moderation_events(chat_id,user_id,kind,source,actor_id,ref) VALUES($1,$2,'kick','roulette','system:roulette',$3),($1,$2,'reset','roulette','system:roulette',$3) ON CONFLICT DO NOTHING",[row.chat_id,row.user_id,row.ref]);
    await c.query(`INSERT INTO obligations(kind,chat_id,user_id,ref,due_at,detail)
      VALUES('roulette_reinvite',$1,$2,$3,$4::timestamptz+$5::int*interval '1 minute',$6) ON CONFLICT DO NOTHING`,[row.chat_id,row.user_id,row.ref,row.attempted_at ?? new Date(),row.detail.punishmentMinutes,JSON.stringify(row.detail)]);
    await c.query('UPDATE group_memberships SET active=false WHERE chat_id=$1 AND user_id=$2',[row.chat_id,row.user_id]);
    await enqueue(c,row.chat_id,`kick-confirmed:${row.id}`,`${row.user_id} está fuera del grupo tras el castigo de ruleta. Warns reiniciados; enlace de regreso programado por privado.`);
  });
}
async function processKick(db:Db,config:Config,row:Obligation,groups:GroupControl):Promise<void>{
  const roster=await groups.roster(row.chat_id);
  const member=findMember(roster,row.user_id);
  if(row.status==='sending' && !member){await confirmedKick(db,row);return;}
  const protectedUser=config.OWNER_JIDS.includes(row.user_id) || config.BOT_JIDS.includes(row.user_id) || Boolean(member?.admin) || !/^\d+@s\.whatsapp\.net$/.test(row.user_id);
  if(protectedUser){
    await transaction(db,async c=>{
      await c.query("UPDATE obligations SET status='skipped' WHERE id=$1",[row.id]);
      await enqueue(c,row.chat_id,`kick-protected:${row.id}`,`${row.user_id} conserva sus warns y no se expulsa: identidad protegida o administración del grupo.`);
    });return;
  }
  if(row.status==='sending'){
    // A person may already have rejoined after a successful ambiguous request.
    await db.query("UPDATE obligations SET status='review' WHERE id=$1",[row.id]);
    await alert(db,config,row,'Expulsión ambigua y participante presente; no se repite a ciegas');return;
  }
  const ch=(await db.query<{enabled:boolean;settings:Chat['settings'] & {roulette_warns?:boolean}}>('SELECT enabled,settings FROM chats WHERE id=$1',[row.chat_id])).rows[0];
  const count=(await db.query<{warns:number}>('SELECT warns FROM moderation_counts WHERE chat_id=$1 AND user_id=$2',[row.chat_id,row.user_id])).rows[0]?.warns ?? 0;
  if(count<product.rouletteWarnLimit || !ch?.enabled || !ch.settings.roulette_warns || !moduleEnabled({id:row.chat_id,isGroup:true,...ch},'games',config) || !moduleEnabled({id:row.chat_id,isGroup:true,...ch},'moderation',config) || !member){
    await db.query("UPDATE obligations SET status='skipped' WHERE id=$1",[row.id]);return;
  }
  if(!botAdmin(roster,config))throw new Error('Bot is not admin');
  // Persist the attempt before the external effect. Restart only reconciles this state.
  const claimed=await db.query<{attempted_at:Date}>("UPDATE obligations SET status='sending',attempted_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1 AND status='pending' AND EXISTS(SELECT 1 FROM moderation_counts m WHERE m.chat_id=obligations.chat_id AND m.user_id=obligations.user_id AND m.warns>=$2) AND EXISTS(SELECT 1 FROM chats ch WHERE ch.id=obligations.chat_id AND ch.enabled AND ch.settings->>'roulette_warns'='true' AND coalesce(ch.settings->'modules'->>'games','true')='true' AND coalesce(ch.settings->'modules'->>'moderation','true')='true') AND NOT EXISTS(SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb) RETURNING attempted_at",[row.id,product.rouletteWarnLimit]);
  if(!claimed.rowCount)return;row.attempted_at=claimed.rows[0]!.attempted_at;
  const outcome=await groups.remove(row.chat_id,row.user_id);
  if(outcome==='retry' || outcome==='rejected'){
    await db.query("UPDATE obligations SET status=$2,due_at=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1",[row.id,outcome==='retry' && row.attempts+1<product.obligationMaxAttempts?'pending':'review',product.retryBaseMs]);
    if(outcome==='rejected' || row.attempts+1>=product.obligationMaxAttempts)await alert(db,config,row,'Evolution rechazó la expulsión o agotó reintentos');return;
  }
  // Both an accepted response and a timeout require a fresh full roster.
  const after=await groups.roster(row.chat_id);
  if(!findMember(after,row.user_id))await confirmedKick(db,row);
  else{
    await db.query("UPDATE obligations SET status='review' WHERE id=$1",[row.id]);
    await alert(db,config,row,'No se confirmó la ausencia del participante');
  }
}
async function processReinvite(db:Db,config:Config,row:Obligation,groups:GroupControl):Promise<void>{
  if(row.status==='queued'){
    const sent=(await db.query<{status:string;reconcile_attempts:number}>('SELECT status,reconcile_attempts FROM outbox WHERE id=$1',[row.outbox_id])).rows[0];
    if(sent?.status==='sent')await db.query("UPDATE obligations SET status='done' WHERE id=$1",[row.id]);
    else if(sent?.status==='failed' || (sent?.status==='uncertain' && sent.reconcile_attempts>=product.maxReconcileAttempts)){
      await db.query("UPDATE obligations SET status='review' WHERE id=$1",[row.id]);await alert(db,config,row,'Enlace privado fallido o incierto');
    }return;
  }
  const link=await groups.invite(row.chat_id);
  if(!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{22}$/.test(link))throw new Error('Invalid invite');
  await transaction(db,async c=>{
    const outbox=await enqueue(c,row.user_id,`roulette-reinvite:${row.id}`,`Terminó tu castigo de ruleta. Puedes volver al grupo: ${link}`,'roulette_reinvite');
    await c.query("UPDATE obligations SET status='queued',outbox_id=$2 WHERE id=$1 AND status='pending'",[row.id,outbox]);
  });
}
export async function tickObligations(db:Db,config:Config,injected?:GroupControl):Promise<void>{
  if(!injected && config.TRANSPORT!=='evolution')return;
  const lock=await db.connect();
  try{
    if(!(await lock.query<{held:boolean}>("SELECT pg_try_advisory_lock(hashtext('botsky-obligations')) AS held")).rows[0]?.held)return;
    const flags=await db.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb");if(flags.rowCount)return;
    const rows=await db.query<Obligation>("SELECT * FROM obligations WHERE status IN ('pending','sending','queued') AND due_at<=clock_timestamp() ORDER BY id LIMIT $1",[product.gameTickBatch]);
    const groups=injected ?? new EvolutionGroups(config);
    for(const row of rows.rows){
      if(row.chat_id!==config.LAB_CHAT_ID)continue;
      try{
        row.detail=z.object({punishmentMinutes:z.number().int().min(1).max(product.rouletteMaxPunishmentMinutes)}).parse(row.detail);
        if(row.kind==='roulette_kick')await processKick(db,config,row,groups);else await processReinvite(db,config,row,groups);
      }catch{
        const current=(await db.query<{status:string}>('SELECT status FROM obligations WHERE id=$1',[row.id])).rows[0];
        if(current?.status==='pending' || current?.status==='sending')await db.query("UPDATE obligations SET attempts=attempts+1,status=CASE WHEN attempts+1 >= $2 THEN 'review' ELSE status END,due_at=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1",[row.id,product.obligationMaxAttempts,product.retryBaseMs]);
        await alert(db,config,row,'Proveedor o permisos no disponibles; obligación conservada');
      }
    }
  }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('botsky-obligations'))");lock.release();}
}
