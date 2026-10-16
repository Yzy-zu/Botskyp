import { z } from 'zod';
import { transaction,type Db } from '../db/client.js';
const participant=z.object({
  id:z.string().regex(/^\d+@(lid|s\.whatsapp\.net)$/),
  phoneNumber:z.string().regex(/^\d+@s\.whatsapp\.net$/).optional(),
  admin:z.enum(['admin','superadmin']).nullish(),
});
const group=z.object({id:z.string(),participants:z.array(participant.refine(p=>!p.id.endsWith('@s.whatsapp.net') || !p.phoneNumber || p.id===p.phoneNumber,'Conflicting provider identity'))});
/** Accept only a complete snapshot obtained from the authenticated group API. */
export async function syncLabMembers(db:Db,labId:string,input:unknown):Promise<void>{
  const snapshot=group.parse(input);
  if(snapshot.id!==labId)throw new Error('Membership snapshot is outside the lab');
  const consistent=await transaction(db,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-memberships'))");
    let conflict=false;
    // Conflicting fresh evidence revokes privilege without deleting or rebinding an alias.
    for(const p of snapshot.participants){
      if(!p.id.endsWith('@lid') || !p.phoneNumber)continue;
      const old=await c.query<{user_id:string}>('SELECT user_id FROM user_aliases WHERE alias=$1',[p.id]);
      if(old.rows[0] && old.rows[0].user_id!==p.phoneNumber){
        await c.query('UPDATE user_aliases SET evidence=$2 WHERE alias=$1',[p.id,`conflict:${p.phoneNumber}`]);
        conflict=true;
      }
    }
    if(conflict)return false;
    await c.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true) ON CONFLICT DO NOTHING',[labId]);
    await c.query('UPDATE group_memberships SET active=false WHERE chat_id=$1',[labId]);
    for(const p of snapshot.participants){
      const canonical=p.phoneNumber ?? p.id;
      await c.query('INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING',[canonical]);
      if(p.id.endsWith('@lid') && p.phoneNumber){
        await c.query('INSERT INTO user_aliases(alias,user_id,evidence) VALUES($1,$2,$3) ON CONFLICT(alias) DO UPDATE SET verified_at=now(),evidence=excluded.evidence',
          [p.id,canonical,`Evolution group participants: ${labId}`]);
      }
      await c.query(`INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES($1,$2,$3)
        ON CONFLICT(chat_id,user_id) DO UPDATE SET active=true,is_admin=excluded.is_admin,last_seen_at=now()`,[labId,canonical,Boolean(p.admin)]);
    }
    return true;
  });
  if(!consistent)throw new Error('Conflicting verified alias; privileges suspended');
}
