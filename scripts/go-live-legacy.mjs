// Run after a verified scripts/backup.sh and deployment:
// docker exec -i botsky-app node --input-type=module < scripts/go-live-legacy.mjs
import assert from 'node:assert/strict';
import {readConfig} from './dist/src/config.js';
import {createDb,transaction} from './dist/src/db/client.js';
import {Evolution} from './dist/src/wa/evolution.js';
import {syncGroupMembers} from './dist/src/core/membership.js';
import {modules} from './dist/src/core/control-tools.js';
import {actorFor,moduleEnabled,privateEligible,permitted} from './dist/src/core/permissions.js';
const normalGroups=['120363315296139888','120363425738569603','120363427750154700','120363432759815247'];
const adminGroups=['120363315296139888','120363425432087417','120363432759815247'];
const normalUsers=['5214435810175','5214432173905','5214431851495'];
const taskUsers=['5214431851495','4431851495'];
const owner='5214435810175@s.whatsapp.net';
// Owner deferred school activation until a school destination is chosen.
const moduleSettings=Object.fromEntries(modules.map(m=>[m,m!=='school']));
const config=readConfig(),db=createDb(config.DATABASE_URL),evolution=new Evolution(config);
try{
  assert.equal(config.INSTANCE,'botsky');assert.equal(config.TRANSPORT,'evolution');
  assert.equal(config.OBSERVER_ENABLED,false);assert.equal(config.ROUTER_MODE,'v1_1');
  assert(config.OWNER_JIDS.includes(owner));
  for(const number of [...normalUsers,...taskUsers].filter(n=>n!=='5214435810175'))assert(!config.OWNER_JIDS.includes(number+'@s.whatsapp.net'));
  assert(await evolution.state(),'Evolution instance must be connected');
  const groupIds=[...new Set([...normalGroups,...adminGroups])].map(id=>id+'@g.us');
  await transaction(db,async c=>{
    for(const id of groupIds){
      await c.query(`INSERT INTO chats(id,is_group,enabled,settings) VALUES($1,true,true,$2)
        ON CONFLICT(id) DO UPDATE SET enabled=true,is_group=true,
        settings=chats.settings || jsonb_build_object('modules',coalesce(chats.settings->'modules','{}'::jsonb)||$3::jsonb)`,
      [id,{modules:moduleSettings},JSON.stringify(moduleSettings)]);
    }
    for(const number of normalUsers){
      const id=number+'@s.whatsapp.net';
      await c.query(`INSERT INTO users(id,private_ok_manual) VALUES($1,true)
        ON CONFLICT(id) DO UPDATE SET private_ok_manual=true`,[id]);
      await c.query(`INSERT INTO chats(id,is_group,enabled) VALUES($1,false,true)
        ON CONFLICT(id) DO UPDATE SET enabled=true`,[id]);
    }
    await c.query("INSERT INTO audit_log(actor_id,action) VALUES($1,'go_live.legacy_allowlists')",[owner]);
  });
  const groups=[];
  for(const id of groupIds){
    let botMember=null,error;
    try{
      const roster=await evolution.participants(id);
      await syncGroupMembers(db,id,roster);
      botMember=roster.participants.some(p=>config.BOT_JIDS.includes(p.id)||config.BOT_JIDS.includes(p.phoneNumber));
    }catch(cause){error=cause.message;}
    const chat=(await db.query('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[id])).rows[0];
    groups.push({id,registered:!!chat,enabled:chat.enabled,isGroup:chat.isGroup,botMember,
      mode:normalGroups.includes(id.split('@')[0])?(adminGroups.includes(id.split('@')[0])?'NORMAL+ADMIN':'NORMAL'):'ADMIN',
      modulesOk:modules.filter(m=>m!=='school').every(m=>moduleEnabled(chat,m,config)),schoolEnabled:moduleEnabled(chat,'school',config),...(error?{error}:{} )});
  }
  const users=[];
  for(const number of normalUsers){
    const id=number+'@s.whatsapp.net';
    users.push(await transaction(db,async c=>{
      const msg={senderId:id,chatId:id,isGroup:false};
      const actor=await actorFor(c,msg,config);
      const chat=(await c.query('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[id])).rows[0];
      const memberships=(await c.query('SELECT chat_id,is_admin FROM group_memberships WHERE user_id=$1 AND active',[id])).rows;
      const aliases=(await c.query("SELECT alias FROM user_aliases WHERE user_id=$1 AND evidence NOT LIKE 'conflict:%'",[id])).rows.map(a=>a.alias);
      return {id,normal:await privateEligible(c,actor),owner:actor.role==='owner',tasks:moduleEnabled(chat,'school',config)&&permitted(actor,chat,'school.write'),memberships,aliases};
    }));
  }
  process.stdout.write(JSON.stringify({head:process.env.BOTSKY_GIT_COMMIT,observer:config.OBSERVER_ENABLED,deferredTasks:{users:taskUsers,enabled:false,targetGroupId:null},groups,users},null,2)+'\n');
}finally{await db.end();}
