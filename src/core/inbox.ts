import { chatLock,lockChatWallets } from '../modules/games/state.js';
import { activity } from '../modules/xp/service.js';
import { createHash } from 'node:crypto';
import { transaction, type Db } from '../db/client.js';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
import { msgSchema, type Msg } from '../wa/types.js';
import { actorFor,privateEligible,type Chat } from './permissions.js';
import { activeSession,sessionAccepts } from './sessions.js';
import { route,rememberContext } from './router.js';
import { Gemini } from './llm.js';
import { searxSearch } from '../modules/web/index.js';
import { commandText } from './shortcuts.js';
import { activated, enableCommand } from './activation.js';

export async function receive(db: Db, config: Config, input: Msg, now = new Date()):Promise<string> {
  const msg = msgSchema.parse(input);
  if (msg.fromMe || now.getTime() - msg.ts.getTime() > config.STALE_SECONDS * 1000 || msg.ts.getTime() - now.getTime() > product.futureToleranceSeconds * 1000) return 'ignored';
  // Phase 0 cannot enable or emit to real groups, including through an owner command.
  if (msg.isGroup && msg.chatId !== config.LAB_CHAT_ID) return 'ignored';
  const key = createHash('sha256').update(JSON.stringify([config.INSTANCE,msg.chatId,msg.id])).digest('hex');
  return transaction(db, async c => {
    const inserted = await c.query('INSERT INTO seen_events(provider_msg_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING provider_msg_id',[key]);
    if (!inserted.rowCount) return 'duplicate';
    await c.query('INSERT INTO inbox(provider_msg_id,chat_id,payload) VALUES($1,$2,$3)',[key,msg.chatId,JSON.stringify(msg)]);
    return 'accepted';
  });
}

export async function processNext(db: Db, config: Config):Promise<boolean> {
  return transaction(db, async c => {
    const result = await c.query<{id:string;payload:unknown;provider_msg_id:string}>("SELECT id,payload,provider_msg_id FROM inbox WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
    const row = result.rows[0];
    if (!row) return false;
    const msg = msgSchema.parse(row.payload);
    const actor=await actorFor(c,msg,config);
    const owner=actor.role==='owner';
    if (!msg.isGroup && msg.chatId===msg.senderId) msg.chatId=actor.id;
    if (msg.quoted) {
      const sent = await c.query('SELECT id FROM outbox WHERE provider_msg_id=$1 AND chat_id=$2 AND status=\'sent\'',[msg.quoted.id,msg.chatId]);
      msg.quoted.fromBot = Boolean(sent.rowCount);
    }
    const flags=await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags');
    const emergency=flags.rows.some(f=>f.key==='emergency' && f.value===true);
    const maintenance=flags.rows.some(f=>f.key==='maintenance' && f.value===true);
    const reactivating=owner && /^reactiva$/iu.test(commandText(msg.text));
    let reply:string|undefined;
    if(!emergency || reactivating){
      if(msg.isGroup && msg.chatId===config.LAB_CHAT_ID && enableCommand(msg.text) && owner){
        await c.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true) ON CONFLICT(id) DO UPDATE SET enabled=true',[msg.chatId]);
        reply='Botsky habilitado en este chat.';
      }else{
        const result=await c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[msg.chatId]);
        let saved=result.rows[0];
        let allowed=saved?.enabled===true;
        if(!msg.isGroup){
          const eligible=await privateEligible(c,actor);
          if(eligible && !saved){
            await c.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,false,true) ON CONFLICT DO NOTHING',[msg.chatId]);
            saved={enabled:true,settings:{}};
          }
          allowed=eligible && (saved?.enabled ?? true);
        }
        const session=await activeSession(c,actor.id,msg.chatId);
        const text=commandText(msg.text);
        const accepts=sessionAccepts(session,text,msg.attachments.length>0);
        if(allowed && msg.isGroup){await chatLock(c,msg.chatId);await lockChatWallets(c,msg.chatId,actor.id);}
        const xpCtx={actor,chat:{id:msg.chatId,isGroup:msg.isGroup,enabled:allowed,settings:saved?.settings ?? {}},msg,db,c,config,now:new Date(),search:async()=>''};
        if(allowed && !maintenance)await activity(xpCtx);
        if(allowed && activated(msg,config.BOT_JIDS,Boolean(accepts))){
          if(maintenance && !owner)reply='Estoy en mantenimiento.';
          else {
            const gemini=new Gemini(db,config,actor.id);
            const ctx={actor,chat:{id:msg.chatId,isGroup:msg.isGroup,enabled:true,settings:saved?.settings ?? {}},msg,db,c,config,now:new Date(),search:(query:string)=>config.WEB_SEARCH_PROVIDER==='gemini'?gemini.search(query):searxSearch(config,query)};
            reply=await route(ctx,config.GEMINI_API_KEY && config.GEMINI_FREE_TIER_CONFIRMED?gemini:undefined);
            if(commandText(msg.text).toLowerCase()==='apagado de emergencia' && owner)reply=undefined;
            if(reply)await rememberContext(ctx,reply);
          }
        }
      }
    }
    if (reply) {
      await c.query(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,
        [msg.chatId,JSON.stringify({text:reply,sourceId:msg.id}),`reply:${row.provider_msg_id}`]);
    }
    await c.query("UPDATE inbox SET status='done' WHERE id=$1",[row.id]);
    return true;
  });
}
