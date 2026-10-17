import { cleanupEphemeral } from '../../core/cleanup.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { moduleEnabled,type Chat } from '../../core/permissions.js';
import { nextOccurrence,recurrenceSchema,formatDue } from './time.js';
import { product } from '../../../config/product.js';
export async function tickCore(db:Db,config:Config):Promise<void>{
  await transaction(db,async c=>{
    const locked=await c.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext('botsky-tick')) AS locked");
    if(!locked.rows[0]?.locked)return;
    await c.query("UPDATE sessions SET status='expired',version=version+1 WHERE status='active' AND kind<>'game' AND expires_at<=clock_timestamp()");
    await cleanupEphemeral(c);
    const flags=await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags');
    if(flags.rows.some(f=>f.key==='emergency' && f.value===true))return;
    const maintenance=flags.rows.some(f=>f.key==='maintenance' && f.value===true);
    const delivered=await c.query<{id:string;recurrence:unknown;timezone:string;delivery_status:string}>(`SELECT r.*,o.status AS delivery_status FROM reminders r JOIN outbox o ON o.id=r.outbox_id WHERE r.status='queued' AND o.status IN ('sent','failed') FOR UPDATE OF r SKIP LOCKED`);
    for(const row of delivered.rows){
      if(row.delivery_status==='failed'){await c.query("UPDATE reminders SET status='failed' WHERE id=$1",[row.id]);continue;}
      if(row.recurrence){const next=nextOccurrence(new Date(),row.timezone,recurrenceSchema.parse(row.recurrence));await c.query("UPDATE reminders SET status='pending',due_at=$2,outbox_id=NULL WHERE id=$1",[row.id,next]);}
      else await c.query("UPDATE reminders SET status='sent' WHERE id=$1",[row.id]);
    }
    const due=await c.query<{id:string;chat_id:string;owner_id:string;body:string;due_at:Date;timezone:string;is_group:boolean;enabled:boolean;settings:Chat['settings']}>(`SELECT r.*,ch.is_group,ch.enabled,ch.settings FROM reminders r JOIN chats ch ON ch.id=r.chat_id
      WHERE r.status='pending' AND r.due_at<=now() ORDER BY r.due_at LIMIT $1 FOR UPDATE OF r SKIP LOCKED`,[product.dueReminderBatch]);
    for(const row of due.rows){
      if(!row.enabled || !moduleEnabled({id:row.chat_id,isGroup:row.is_group,enabled:row.enabled,settings:row.settings},'reminders',config))continue;
      const owner=config.OWNER_JIDS.includes(row.owner_id) && !row.owner_id.endsWith('@lid');
      if(maintenance && !owner)continue;
      if(!owner){const access=await c.query(`SELECT 1 FROM users WHERE id=$1 AND (
        ($3 AND EXISTS(SELECT 1 FROM group_memberships WHERE user_id=$1 AND chat_id=$2 AND active AND last_seen_at>now()-$4::int*interval '1 millisecond'))
        OR (NOT $3 AND (private_ok_manual OR EXISTS(SELECT 1 FROM group_memberships m JOIN chats ch ON ch.id=m.chat_id WHERE m.user_id=$1 AND m.active AND ch.enabled AND m.last_seen_at>now()-$4::int*interval '1 millisecond'))))`,[row.owner_id,row.chat_id,row.is_group,product.membershipMaxAgeMs]);if(!access.rowCount)continue;}
      const late=Date.now()-row.due_at.getTime()>product.tickMs*2;
      const text=`Recordatorio #${row.id}: ${row.body}\nProgramado: ${formatDue(row.due_at,row.timezone)}${late?'\nVa con retraso por una interrupción.':''}`;
      const key=`reminder:${row.id}:${row.due_at.toISOString()}`;
      const out=await c.query<{id:string}>(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,[row.chat_id,JSON.stringify({text,sourceId:''}),key]);
      await c.query("UPDATE reminders SET status='queued',outbox_id=$2 WHERE id=$1",[row.id,out.rows[0]!.id]);
    }
  });
}
