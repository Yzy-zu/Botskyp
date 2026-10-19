import { observer } from '../observer/index.js';
import { prepareArtifactsV2 } from './prepare-artifacts-v2.js';
import { readSessionV2, decideSessionV2 } from './sessions-v2.js';
import { recentReminderV2 } from './recent-followup-v2.js';
import { sanitizeOutputV2 } from './output-sanitizer-v2.js';
import { registerIncomingArtifactsV2 } from './artifact-registration-v2.js';
import { modules } from './control-tools.js';
import { chatLock,lockChatWallets } from '../modules/games/state.js';
import { activity } from '../modules/xp/service.js';
import { createHash } from 'node:crypto';
import { transaction, type Db } from '../db/client.js';
import { configForChat, type Config } from '../config.js';
import { product } from '../../config/product.js';
import { msgSchema, type Msg } from '../wa/types.js';
import { actorFor,privateEligible,type Chat,QA_OWNER_JID,QA_MEMBER_JID } from './permissions.js';
import { activeSession,sessionAccepts } from './sessions.js';
import { route,rememberContext } from './router.js';
import { getSharedMultiProviderRouter } from './llm.js';
import { searxSearch } from '../modules/web/index.js';
import { commandText } from './shortcuts.js';
import { activated, enableCommand } from './activation.js';

export async function receive(db: Db, config: Config, input: Msg, now = new Date(), rawEvolution?:unknown):Promise<string> {
  const msg = msgSchema.parse(input);
  if (msg.qaMode && (msg.chatId !== config.LAB_CHAT_ID || (![QA_OWNER_JID, QA_MEMBER_JID].includes(msg.senderId) && !config.OWNER_JIDS.includes(msg.senderId)))) {
    delete msg.qaMode;
  }
  if(msg.isGroup!==msg.chatId.endsWith('@g.us'))return 'ignored';
  if (msg.fromMe || now.getTime() - msg.ts.getTime() > config.STALE_SECONDS * 1000 || msg.ts.getTime() - now.getTime() > product.futureToleranceSeconds * 1000) return 'ignored';
  if(msg.isGroup){
    const enabled=await db.query('SELECT 1 FROM chats WHERE id=$1 AND is_group AND enabled',[msg.chatId]);
    if(!enabled.rowCount && (configForChat(config,msg.chatId).ROUTER_MODE==='v1_1' || !(enableCommand(msg.text) && (await transaction(db,c=>actorFor(c,msg,config))).role==='owner')))return 'ignored';
  }
  const key = createHash('sha256').update(JSON.stringify([config.INSTANCE,msg.chatId,msg.id])).digest('hex');
  return transaction(db, async c => {
    const inserted = await c.query('INSERT INTO seen_events(provider_msg_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING provider_msg_id',[key]);
    if (!inserted.rowCount) return 'duplicate';
    const accepted=await c.query<{id:string;turn_id:string}>('INSERT INTO inbox(provider_msg_id,chat_id,payload) VALUES($1,$2,$3) RETURNING id,turn_id',[key,msg.chatId,JSON.stringify(msg)]);
    const row=accepted.rows[0]!;
    observer.bindClient(c,{turnId:row.turn_id,inboxId:row.id,chatId:msg.chatId,actorId:msg.senderId,providerMsgId:msg.id,sourceMessageId:msg.id,routerMode:config.ROUTER_MODE});
    observer.emit(()=>({eventType:'INBOUND_ACCEPTED',stage:'evolution.inbound',payload:{rawEvolution,providerDedupeKey:key,transaction:'pending_commit'}}));
    observer.emit(()=>({eventType:'INBOUND_NORMALIZED',stage:'normalization',payload:{userText:msg.text,isGroup:msg.isGroup,msg}}));
    return 'accepted';
  });
}

export async function processNext(db: Db, baseConfig: Config):Promise<boolean> {
  return transaction(db, async c => {
    const result = await c.query<{id:string;payload:unknown;provider_msg_id:string;turn_id:string;chat_id:string}>("SELECT id,payload,provider_msg_id,turn_id,chat_id FROM inbox WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
    const row = result.rows[0];
    if (!row) return false;
    const msg = msgSchema.parse(row.payload);
    const config=configForChat(baseConfig,msg.chatId);
    observer.bindClient(c,{turnId:row.turn_id,inboxId:row.id,chatId:msg.chatId,actorId:msg.senderId,providerMsgId:msg.id,sourceMessageId:msg.id,routerMode:config.ROUTER_MODE});
    observer.bindClient(c,{...observer.clientIds(c),processing:true});
    observer.emit({eventType:'TRANSACTION_STARTED',stage:'inbox.business'});
    observer.emit({eventType:'TURN_STARTED',stage:'inbox',payload:{inboxId:row.id}});
    const actor=await actorFor(c,msg,config);
    observer.bindClient(c,{...observer.clientIds(c),actorId:actor.id});
    const owner=actor.role==='owner';
    if (!msg.isGroup && msg.chatId===msg.senderId) msg.chatId=actor.id;
    observer.bindClient(c,{...observer.clientIds(c),chatId:msg.chatId});
    // Preserve the raw envelope key while following v1's authenticated private-chat canonicalization.
    if (row.chat_id!==msg.chatId) await c.query('UPDATE message_turns SET resolved_chat_id=$2 WHERE id=$1 AND resolved_chat_id<>$2',[row.turn_id,msg.chatId]);
    if (msg.quoted) {
      const sent = await c.query('SELECT id FROM outbox WHERE provider_msg_id=$1 AND chat_id=$2 AND status=\'sent\'',[msg.quoted.id,msg.chatId]);
      msg.quoted.fromBot = Boolean(sent.rowCount);
    }
    if(config.ROUTER_MODE==='v1_1')await registerIncomingArtifactsV2(c,config,msg.chatId,actor.id,msg.id);
    const flags=await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags');
    const emergency=flags.rows.some(f=>f.key==='emergency' && f.value===true);
    const maintenance=flags.rows.some(f=>f.key==='maintenance' && f.value===true);
    const reactivating=owner && (config.ROUTER_MODE==='v1_1' || /^reactiva$/iu.test(commandText(msg.text)));
    let reply:string|undefined;
    if(!emergency || reactivating){
      if(config.ROUTER_MODE!=='v1_1' && msg.isGroup && enableCommand(msg.text) && owner){
        await chatLock(c,msg.chatId);
        await c.query('INSERT INTO chats(id,is_group,enabled,settings) VALUES($1,true,true,$2) ON CONFLICT(id) DO UPDATE SET enabled=true',[msg.chatId,JSON.stringify(msg.chatId===config.LAB_CHAT_ID?{}:{modules:Object.fromEntries(modules.map(m=>[m,false]))})]);
        await c.query("INSERT INTO audit_log(actor_id,chat_id,action) VALUES($1,$2,'chat.enable')",[actor.id,msg.chatId]);
        reply='Botsky habilitado en este chat. Activa cada módulo explícitamente con «bot activa <módulo> aquí».';

      }else if(config.ROUTER_MODE!=='v1_1' && msg.isGroup && owner && /^deshabilita este chat$/iu.test(commandText(msg.text))){
        await chatLock(c,msg.chatId);
        await c.query('UPDATE chats SET enabled=false WHERE id=$1',[msg.chatId]);
        await c.query("UPDATE outbox SET status='failed',last_error='chat_disabled' WHERE chat_id=$1 AND status='queued'",[msg.chatId]);
        await c.query("INSERT INTO audit_log(actor_id,chat_id,action) VALUES($1,$2,'chat.disable')",[actor.id,msg.chatId]);
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
        const text=config.ROUTER_MODE==='v1_1'?'':commandText(msg.text);
        const v2Session=config.ROUTER_MODE==='v1_1'?await readSessionV2(c,actor.id,msg.chatId):undefined;
        const v2Decision=decideSessionV2(v2Session,msg.text,new Date(),msg.attachments.length>0);
        // An actor's live foreground/game interaction or recent reminder follow-up keeps activation while Gemini decides the intent.
        const recentFollowup=config.ROUTER_MODE==='v1_1' && !v2Session && Boolean(await recentReminderV2(c,msg.chatId,actor.id,new Date()));
        const accepts=config.ROUTER_MODE==='v1_1'? recentFollowup || !['not_consumed','expired'].includes(v2Decision.kind) || Boolean(v2Session && v2Session.expires_at>new Date()) || session?.kind==='game':sessionAccepts(session,text,msg.attachments.length>0);
        if(allowed && msg.isGroup){if(config.ROUTER_MODE==='v1_1')await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-v2-execution-admission'))");await chatLock(c,msg.chatId);await lockChatWallets(c,msg.chatId,actor.id);}
        const xpCtx={turnId:row.turn_id,actor,chat:{id:msg.chatId,isGroup:msg.isGroup,enabled:allowed,settings:saved?.settings ?? {}},msg,db,c,config,now:new Date(),search:async()=>''};
        if(allowed && !maintenance)await activity(xpCtx);
        if(config.ROUTER_MODE==='v1_1' && allowed && msg.attachments.length && (!msg.isGroup || owner || actor.groupMember))await prepareArtifactsV2(xpCtx);
        if(allowed && activated(msg,config.BOT_JIDS,Boolean(accepts))){
          if(msg.isGroup && !owner && !actor.groupMember)reply='No.';
          else if(maintenance && !owner)reply='Estoy en mantenimiento.';
          else {
            const llmBackend=getSharedMultiProviderRouter(config,{db,actor:actor.id});
            const ctx={...(config.ROUTER_MODE==='v1_1'?{inboxTransaction:true as const}:{}),turnId:row.turn_id,actor,chat:{id:msg.chatId,isGroup:msg.isGroup,enabled:true,settings:saved?.settings ?? {}},msg,db,c,config,now:new Date(),search:(query:string)=>config.WEB_SEARCH_PROVIDER==='gemini'?llmBackend.search(query,config.ROUTER_MODE==='v1_1'?row.turn_id:undefined):searxSearch(config,query)};
            reply=await route(ctx,llmBackend);
            if(config.ROUTER_MODE!=='v1_1' && commandText(msg.text).toLowerCase()==='apagado de emergencia' && owner)reply=undefined;
            if(reply)await rememberContext(ctx,reply);
          }
        }
      }
    }
    observer.emit(()=>({eventType:'OUTPUT_SANITIZED',stage:'inbox.before_sanitizer',payload:{text:reply}}));
    if (reply && config.ROUTER_MODE==='v1_1') reply=sanitizeOutputV2(reply);
    observer.emit(()=>({eventType:'OUTPUT_SANITIZED',stage:'inbox.after_sanitizer',payload:{finalReply:reply}}));
    if (reply) {
      const queued=await c.query(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [msg.chatId,JSON.stringify({text:reply,sourceId:msg.id}),`reply:${row.provider_msg_id}`]);
      observer.emit(()=>({eventType:'OUTBOX_QUEUED',stage:'inbox.reply',payload:{outboxId:queued.rows[0]?.id,chatId:msg.chatId,payload:{text:reply,sourceId:msg.id},transaction:'pending_commit'}}));
    }
    await c.query("UPDATE inbox SET status='done' WHERE id=$1",[row.id]);
    return true;
  });
}
