import { rosterSchema } from '../wa/group-control.js';
import { transaction,type Db } from '../db/client.js';
/** Accept only a complete snapshot obtained from the authenticated group API. */
export async function syncGroupMembers(db:Db,chatId:string,input:unknown):Promise<void>{
  const snapshot=rosterSchema.parse(input);
  if(snapshot.id!==chatId)throw new Error('Membership snapshot is outside the requested group');
  const consistent=await transaction(db,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-memberships'))");
    const chat=await c.query('SELECT 1 FROM chats WHERE id=$1 AND enabled AND is_group FOR SHARE',[chatId]);
    if(!chat.rowCount)return true;
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
    if(snapshot.subject)await c.query("UPDATE chats SET settings=jsonb_set(settings,'{group_title}',to_jsonb($2::text)) WHERE id=$1",[chatId,snapshot.subject]);
    await c.query('UPDATE group_memberships SET active=false WHERE chat_id=$1',[chatId]);
    for(const p of snapshot.participants){
      const canonical=p.phoneNumber ?? p.id;
      await c.query('INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING',[canonical]);
      if(p.id.endsWith('@lid') && p.phoneNumber){
        await c.query('INSERT INTO user_aliases(alias,user_id,evidence) VALUES($1,$2,$3) ON CONFLICT(alias) DO UPDATE SET verified_at=now(),evidence=excluded.evidence',
          [p.id,canonical,`Evolution group participants: ${chatId}`]);
      }
      await c.query(`INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES($1,$2,$3)
        ON CONFLICT(chat_id,user_id) DO UPDATE SET active=true,is_admin=excluded.is_admin,last_seen_at=now()`,[chatId,canonical,Boolean(p.admin)]);
    }
    return true;
  });
  if(!consistent)throw new Error('Conflicting verified alias; privileges suspended');
}

// Compatibility for the phase 0 fixtures; production refreshes every enabled group.
export const syncLabMembers=syncGroupMembers;
export async function syncEnabledGroups(db:Db,participants:(chatId:string)=>Promise<unknown>):Promise<void>{
  const chats=await db.query<{id:string}>('SELECT id FROM chats WHERE enabled AND is_group ORDER BY id');
  let failed=false;
  for(const chat of chats.rows){
    try{await syncGroupMembers(db,chat.id,await participants(chat.id));}
    catch{failed=true;}
  }
  if(failed)throw new Error('Some enabled groups could not refresh memberships');
}
