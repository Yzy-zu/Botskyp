import { createHash } from 'node:crypto';
import { transaction, type Db } from '../db/client.js';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
import { msgSchema, type Msg } from '../wa/types.js';
import { activated, enableCommand, isPing } from './activation.js';

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
    const alias = await c.query<{user_id:string}>("SELECT user_id FROM user_aliases WHERE alias=$1 AND evidence NOT LIKE 'conflict:%'",[msg.senderId]);
    const actor = alias.rows[0]?.user_id ?? msg.senderId;
    const owner = config.OWNER_JIDS.includes(actor);
    if (!msg.isGroup && msg.chatId===msg.senderId) msg.chatId=actor;
    if (msg.quoted) {
      const sent = await c.query('SELECT id FROM outbox WHERE provider_msg_id=$1 AND chat_id=$2 AND status=\'sent\'',[msg.quoted.id,msg.chatId]);
      msg.quoted.fromBot = Boolean(sent.rowCount);
    }
    const panic = await c.query("SELECT key FROM system_flags WHERE key='emergency' AND value='true'::jsonb");
    let reply: string | undefined;
    if (!panic.rowCount) {
      if (msg.isGroup && msg.chatId === config.LAB_CHAT_ID && enableCommand(msg.text) && owner) {
        await c.query(`INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true) ON CONFLICT(id) DO UPDATE SET enabled=true`,[msg.chatId]);
        reply = 'Botsky habilitado en este chat.';
      } else {
        const chat = await c.query<{enabled:boolean}>('SELECT enabled FROM chats WHERE id=$1',[msg.chatId]);
        let allowed = chat.rows[0]?.enabled === true;
        if (!msg.isGroup) {
          const access = await c.query(`SELECT id FROM users WHERE id=$1 AND (private_ok_manual OR EXISTS(
            SELECT 1 FROM group_memberships m JOIN chats c ON c.id=m.chat_id WHERE m.user_id=$1 AND m.active AND c.enabled))`,[actor]);
          const eligible = owner || Boolean(access.rowCount);
          if (eligible && !chat.rows[0]) {
            await c.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,false,true) ON CONFLICT DO NOTHING',[msg.chatId]);
          }
          allowed = eligible && (chat.rows[0]?.enabled ?? true);
        }
        if (allowed && activated(msg, config.BOT_JIDS) && isPing(msg.text)) reply = 'pong';
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
