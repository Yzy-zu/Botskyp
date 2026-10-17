import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive } from '../src/core/inbox.js';
import { actorFor } from '../src/core/permissions.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
import { digest } from '../src/modules/media/storage.js';
import { extension } from '../src/modules/media/catalog.js';
import { registerArtifactV2 } from '../src/core/artifact-registration-v2.js';
export const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Unsafe test database');
export const db = createDb(url), owner = '100@s.whatsapp.net', member = '101@s.whatsapp.net', chat = '300@g.us';
export const config = readConfig({ DATABASE_URL: url, EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: owner, BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: chat, TRANSPORT: 'mock', ROUTER_MODE: 'v1_1', MINECRAFT_ENABLED: 'true' });
export const pdf = Buffer.from('%PDF-1.7\nfixture');
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64');
export const initialize = () => migrate(db);
export async function reset(): Promise<void> {
  await db.query('TRUNCATE chats,users,message_turns,seen_events,inbox,outbox,jobs,notes,reminders,user_memories,context_msgs,system_flags,sessions,audit_log,wallets,games,bulk_ops CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true),('400@g.us',true,true),('100@s.whatsapp.net',false,true),('101@s.whatsapp.net',false,true)");
  await db.query('INSERT INTO users(id,display_name) VALUES($1,\'Dueño\'),($2,\'Amigo\')', [owner,member]);
  await db.query('INSERT INTO group_memberships(chat_id,user_id) VALUES($1,$2),($1,$3)', [chat,owner,member]);
}
export async function context<T>(input: Partial<Msg>, fn: (ctx: ToolCtx) => Promise<T>): Promise<T> {
  const msg: Msg = { id: randomUUID(), text: 'eso', chatId: chat, senderId: owner, isGroup: true, ts: new Date(), fromMe: false, mentions: [], attachments: [], ...input };
  await receive(db,config,msg);
  const turn = (await db.query<{turn_id:string}>('SELECT turn_id FROM inbox WHERE payload->>\'id\'=$1', [msg.id])).rows[0]!;
  const c=await db.connect();
  try {
    const actor=await actorFor(c,msg,config);
    return await fn({c,db,config,now:new Date(),turnId:turn.turn_id,msg,actor,chat:{id:msg.chatId,isGroup:msg.isGroup,enabled:true,settings:{}},search:async()=>''});
  } finally { c.release(); }
}
export async function backing(ctx: ToolCtx, options: { mime?: string; bytes?: Buffer; school?: boolean; filename?: string } = {}) {
  const mime=options.mime ?? 'application/pdf', bytes=options.bytes ?? pdf;
  return transaction(db,async c=>{
    const id=options.school ? (await c.query<{id:string}>(`INSERT INTO school_attachments(chat_id,owner_id,source_message_id,kind,mime,size,data,expires_at)
      VALUES($1,$2,$3,'document',$4,$5,$6,clock_timestamp()+interval '7 days') RETURNING id`,[ctx.chat.id,ctx.actor.id,ctx.msg.id,mime,bytes.length,bytes])).rows[0]!.id
      : (await c.query<{id:string}>(`INSERT INTO media_attachments(chat_id,owner_id,source_message_id,is_original,mime,extension,size,sha256,data,expires_at)
        VALUES($1,$2,$3,true,$4,$5,$6,$7,$8,clock_timestamp()+interval '7 days') RETURNING id`,[ctx.chat.id,ctx.actor.id,ctx.msg.id,mime,extension(mime),bytes.length,digest(bytes),bytes])).rows[0]!.id;
    const a=await registerArtifactV2(c,'v1_1',{chatId:ctx.chat.id,actorId:ctx.actor.id,sourceMessageId:ctx.msg.id,origin:'user_input',...(options.school?{schoolId:id}:{mediaId:id}),...(options.filename?{filename:options.filename}:{})});
    if(!a)throw new Error('Fixture artifact missing');
    return a;
  });
}
export async function count(table:string):Promise<number>{return (await db.query<{n:number}>(`SELECT count(*)::int n FROM ${table}`)).rows[0]!.n;}
