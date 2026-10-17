import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive, processNext } from '../src/core/inbox.js';
import * as router from '../src/core/router.js';
import { executionArgsHash, executionKey, callOrigins, type CallOrigin } from '../src/core/tool-execution.js';
import { lastChatArtifact } from '../src/core/chat-artifacts.js';
import type { Msg } from '../src/wa/types.js';
const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Unsafe test database');
const db = createDb(url);
const config = readConfig({ DATABASE_URL: url, EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: '100@s.whatsapp.net', BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: '300@g.us', TRANSPORT: 'mock' });
const actor = '100@s.whatsapp.net';
const chat = config.LAB_CHAT_ID;
function msg(id: string = randomUUID(), chatId = chat): Msg { return { id, chatId, senderId: actor, isGroup: true, ts: new Date(), text: 'bot ping', mentions: [], fromMe: false, attachments: [] }; }
async function turn(id: string = randomUUID(), chatId = chat): Promise<{ turn_id: string; source: string }> {
  await receive(db, config, msg(id, chatId));
  const row = (await db.query<{ turn_id: string }>("SELECT turn_id FROM inbox WHERE chat_id=$1 AND payload->>'id'=$2", [chatId, id])).rows[0]!;
  return { ...row, source: id };
}
const hash = executionArgsHash('bulk.nuclear', { count: 8 });
type ExecutionOptions = { origin?: CallOrigin; provider?: string | null; key?: string; tool?: string; argsHash?: string; actorId?: string; chatId?: string; parent?: string | null; logical?: string; status?: string };
async function execution(t: Awaited<ReturnType<typeof turn>>, options: ExecutionOptions = {}) {
  const { origin = 'fast_path', provider = null, tool = 'bulk.nuclear', argsHash = hash, actorId = actor, chatId = chat, parent = null, logical = randomUUID(), status = 'queued' } = options;
  const key = options.key ?? executionKey({ turnId: t.turn_id, chatId, actorId, sourceMessageId: t.source, toolName: tool, argsHash, callOrigin: origin, ...(provider === null ? {} : { providerCallId: provider }) });
  return (await db.query<{ id: string; logical_action_id: string }>(`INSERT INTO tool_executions
    (turn_id,call_origin,provider_call_id,execution_key,source_message_id,chat_id,actor_id,tool_name,risk_level,args_hash,status,parent_execution_id,logical_action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'destructive',$9,$10,$11,$12) RETURNING id,logical_action_id`,
  [t.turn_id, origin, provider, key, t.source, chatId, actorId, tool, argsHash, status, parent, logical])).rows[0]!;
}
beforeAll(() => migrate(db));
afterAll(() => db.end());
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.query('TRUNCATE message_turns,inbox,seen_events,chats,users,outbox,system_flags CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true),('400@g.us',true,true)");
});
it('upgrades 001–010 with existing rows, preserves data and safely backfills distinct turns', async () => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('CREATE SCHEMA r1_upgrade');
    await c.query('SET LOCAL search_path TO r1_upgrade');
    const dir = 'src/db/migrations/';
    for (const file of readdirSync(dir).filter(name => /^0(0[1-9]|10)_/.test(name)).sort()) await c.query(readFileSync(dir + file, 'utf8'));
    await c.query("INSERT INTO seen_events(provider_msg_id) VALUES('old-a'),('old-b')");
    await c.query(`INSERT INTO inbox(provider_msg_id,chat_id,payload,status) VALUES
      ('old-a','300@g.us','{"id":"raw-a","text":"original"}','done'),
      ('old-b','400@g.us','{"id":"raw-b"}','queued')`);
    const original = (await c.query('SELECT * FROM inbox ORDER BY id')).rows;
    await c.query(readFileSync(dir + '011_v1_1_natural_router.sql', 'utf8'));
    const upgraded = (await c.query('SELECT * FROM inbox ORDER BY id')).rows;
    expect(upgraded.map(({ turn_id: ignored, ...row }) => { expect(ignored).toMatch(/^[a-f0-9-]{36}$/); return row; })).toEqual(original);
    expect(new Set(upgraded.map(row => row.turn_id)).size).toBe(2);
    expect((await c.query('SELECT source_message_id FROM message_turns ORDER BY source_message_id')).rows).toEqual([{ source_message_id: 'raw-a' }, { source_message_id: 'raw-b' }]);
    const indexes = (await c.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname='r1_upgrade'")).rows;
    expect(indexes.every(row => !/WHERE.*(?:now\(|clock_timestamp\()/i.test(row.indexdef))).toBe(true);
  } finally { await c.query('ROLLBACK'); c.release(); }
});
it('persists a turn through duplicate webhooks, failed processNext, a fresh connection and retry', async () => {
  const input = msg();
  const results = await Promise.all(Array.from({ length: 8 }, () => receive(db, config, input)));
  expect(results.filter(value => value === 'accepted')).toHaveLength(1);
  const t = (await db.query<{ turn_id: string }>('SELECT turn_id FROM inbox')).rows[0]!;
  const actual = router.route;
  const spy = vi.spyOn(router, 'route').mockRejectedValueOnce(new Error('simulated crash'));
  await expect(processNext(db, config)).rejects.toThrow('simulated crash');
  expect(spy.mock.calls[0]?.[0].turnId).toBe(t.turn_id);
  spy.mockImplementation(actual);
  const restarted = createDb(url);
  try { expect(await processNext(restarted, config)).toBe(true); } finally { await restarted.end(); }
  expect(spy.mock.calls[1]?.[0].turnId).toBe(t.turn_id);
  expect((await db.query('SELECT status,turn_id FROM inbox')).rows[0]).toEqual({ status: 'done', turn_id: t.turn_id });
  expect((await db.query('SELECT payload FROM outbox')).rows[0]?.payload.text).toBe('pong');
  expect(await processNext(db, config)).toBe(false);
});
it('keeps message identity after ephemeral inbox cleanup and separates identical raw IDs across chats', async () => {
  const t = await turn('same-raw');
  const other = await turn('same-raw', '400@g.us');
  expect(other.turn_id).not.toBe(t.turn_id);
  await execution(t);
  await db.query('DELETE FROM inbox');
  await db.query('DELETE FROM seen_events');
  expect((await turn('same-raw')).turn_id).toBe(t.turn_id);
  await expect(db.query('UPDATE inbox SET turn_id=$1', [randomUUID()])).rejects.toMatchObject({ code: '23514' });
});
it.each(callOrigins)('has deterministic execution keys and retry dedupe for %s without fake provider IDs', async origin => {
  const t = await turn();
  const identity = { turnId: t.turn_id, chatId: chat, actorId: actor, sourceMessageId: t.source, toolName: 'bulk.nuclear', argsHash: hash, callOrigin: origin };
  expect(executionKey(identity)).toBe(executionKey({ ...identity }));
  expect(executionArgsHash('x', { a: 1, b: { c: 2, d: 3 } })).toBe(executionArgsHash('x', { b: { d: 3, c: 2 }, a: 1 }));
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => execution(t, { origin })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await db.query('SELECT provider_call_id FROM tool_executions')).rows[0]?.provider_call_id).toBeNull();
});
it('dedupes provider IDs independently of args/tool and effects independently of provider ID/origin', async () => {
  const t = await turn();
  await execution(t, { origin: 'llm', provider: 'Exact-ID' });
  await expect(execution(t, { origin: 'llm', provider: 'Exact-ID', tool: 'other', key: 'changed' })).rejects.toMatchObject({ code: '23505' });
  await expect(execution(t, { origin: 'llm', provider: 'Another-ID', key: 'another' })).rejects.toMatchObject({ code: '23505' });
  await expect(execution(t, { origin: 'session', key: 'session' })).rejects.toMatchObject({ code: '23505' });
  await expect(db.query("UPDATE tool_executions SET call_origin='internal' WHERE provider_call_id IS NOT NULL")).rejects.toMatchObject({ code: '23514' });
  const otherTurn = await turn();
  await execution(otherTurn, { origin: 'llm', provider: 'Exact-ID' }); // IDs are scoped to the provider turn.
});
it('rejects invalid states, origin, risk, missing keys and mismatched turn source/chat', async () => {
  const t = await turn();
  await expect(execution(t, { status: 'success' })).rejects.toMatchObject({ code: '23514' });
  await expect(execution(t, { key: '' })).rejects.toMatchObject({ code: '23514' });
  await expect(execution(t, { chatId: '400@g.us' })).rejects.toMatchObject({ code: '23503' });
  await expect(execution({ ...t, source: 'forged' })).rejects.toMatchObject({ code: '23503' });
  await execution(t);
  await expect(db.query("UPDATE tool_executions SET risk_level='unsafe'")).rejects.toMatchObject({ code: '23514' });
  await expect(db.query("UPDATE tool_executions SET call_origin='fake'")).rejects.toMatchObject({ code: '23514' });
});
it('appends confirmation in a new turn, preserving original status and scoped lineage', async () => {
  const first = await turn();
  const second = await turn();
  const parent = await execution(first, { status: 'needs_confirmation' });
  const child = await execution(second, { origin: 'session', parent: parent.id, logical: parent.logical_action_id });
  await db.query("UPDATE tool_executions SET status='ok',result_json='{\"status\":\"ok\"}',finished_at=clock_timestamp() WHERE id=$1", [child.id]);
  expect((await db.query('SELECT status,turn_id FROM tool_executions WHERE id=$1', [parent.id])).rows[0]).toEqual({ status: 'needs_confirmation', turn_id: first.turn_id });
  expect((await db.query('SELECT status,turn_id,parent_execution_id,logical_action_id FROM tool_executions WHERE id=$1', [child.id])).rows[0]).toEqual({ status: 'ok', turn_id: second.turn_id, parent_execution_id: parent.id, logical_action_id: parent.logical_action_id });
  await expect(db.query("UPDATE tool_executions SET status='ok' WHERE id=$1", [parent.id])).rejects.toMatchObject({ code: '23514' });
  const third = await turn();
  await expect(execution(third, { parent: parent.id, logical: parent.logical_action_id, actorId: 'other' })).rejects.toMatchObject({ code: '23503' });
  await expect(execution(third, { parent: parent.id, logical: parent.logical_action_id, argsHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: '23514' });
  await expect(execution(third, { parent: parent.id })).rejects.toMatchObject({ code: '23503' });
});
it.each(['v1', 'v1_1_shadow', 'v1_1'] as const)('routes ping under %s, with v2 receipts only when enabled', async mode => {
  await receive(db, config, msg());
  await processNext(db, { ...config, ROUTER_MODE: mode });
  expect((await db.query('SELECT payload FROM outbox')).rows[0]?.payload.text).toBe('pong');
  expect((await db.query('SELECT * FROM tool_executions')).rowCount).toBe(mode==='v1_1'?1:0);
});

async function artifact(t: Awaited<ReturnType<typeof turn>>, options: { parent?: string; school?: boolean; chatId?: string; actorId?: string; age?: number; expires?: number; backingExpires?: number; data?: Buffer | null } = {}) {
  const chatId = options.chatId ?? chat, actorId = options.actorId ?? actor;
  const expires = options.expires ?? 100, backingExpires = options.backingExpires ?? 100;
  const data = options.data === undefined ? Buffer.from('file') : options.data;
  const backing = options.school
    ? (await db.query<{ id: string }>(`INSERT INTO school_attachments(chat_id,owner_id,source_message_id,kind,mime,data,size,expires_at)
      VALUES($1,$2,$3,'document','application/pdf',$4,4,now()+$5::int*interval '1 hour') RETURNING id`, [chatId, actorId, randomUUID(), data, backingExpires])).rows[0]!.id
    : (await db.query<{ id: string }>(`INSERT INTO media_attachments(chat_id,owner_id,is_original,mime,extension,size,sha256,data,expires_at)
      VALUES($1,$2,false,'application/pdf','pdf',4,$3,$4,now()+$5::int*interval '1 hour') RETURNING id`, [chatId, actorId, 'a'.repeat(64), data, backingExpires])).rows[0]!.id;
  return (await db.query<{ id: string }>(`INSERT INTO chat_artifacts(chat_id,actor_id,turn_id,source_message_id,media_attachment_id,school_attachment_id,parent_artifact_id,kind,mime,created_at,expires_at,origin)
    VALUES($1,$2,$3,$4,$5,$6,$7,'pdf','application/pdf',now()-$8::int*interval '1 hour',now()+$9::int*interval '1 hour',$10) RETURNING id`,
  [chatId, actorId, t.turn_id, t.source, options.school ? null : backing, options.school ? backing : null, options.parent ?? null, options.age ?? 0, expires, options.school ? 'user_input' : 'bot_output'])).rows[0]!;
}
it('builds an artifact chain across turns with real media/school backing; A_LAST uses scope and runtime expiry', async () => {
  const t = await turn();
  const original = await artifact(t, { school: true, age: 4 });
  const pdf = await artifact(await turn(), { parent: original.id, age: 3 });
  const compressed = await artifact(await turn(), { parent: pdf.id, age: 2 });
  await artifact(t, { age: 2, expires: -1 });
  await artifact(t, { data: null });
  await artifact(t, { backingExpires: -1 });
  await artifact(t, { actorId: 'other' });
  await artifact(await turn(randomUUID(), '400@g.us'), { chatId: '400@g.us' });
  expect((await lastChatArtifact(db, chat, actor))?.id).toBe(compressed.id);
  expect((await db.query('SELECT parent_artifact_id FROM chat_artifacts WHERE id=$1', [compressed.id])).rows[0]?.parent_artifact_id).toBe(pdf.id);
  expect(await lastChatArtifact(db, 'unknown-chat', actor)).toBeUndefined();
  expect(await lastChatArtifact(db, chat, 'unknown-actor')).toBeUndefined();
});
it('enforces actual backing FKs, exactly one backing, and parent chat/actor scope', async () => {
  const t = await turn();
  const parent = await artifact(t);
  await expect(artifact(t, { actorId: 'other', parent: parent.id })).rejects.toMatchObject({ code: '23503' });
  const other = await turn(randomUUID(), '400@g.us');
  await expect(artifact(other, { chatId: '400@g.us', parent: parent.id })).rejects.toMatchObject({ code: '23503' });
  await expect(db.query('UPDATE chat_artifacts SET media_attachment_id=$1 WHERE id=$2', [randomUUID(), parent.id])).rejects.toMatchObject({ code: '23503' });
  await expect(db.query('UPDATE chat_artifacts SET media_attachment_id=NULL WHERE id=$1', [parent.id])).rejects.toMatchObject({ code: '23514' });
  const school = await artifact(t, { school: true });
  await expect(db.query('UPDATE chat_artifacts SET school_attachment_id=$1 WHERE id=$2', [randomUUID(), school.id])).rejects.toMatchObject({ code: '23503' });
  await expect(db.query("UPDATE chat_artifacts SET actor_id='other' WHERE id=$1", [school.id])).rejects.toMatchObject({ code: '23503' });
});
it.each(['ok','denied','needs_confirmation','needs_clarification','not_found','queued','uncertain','error'])('stores the %s result status without implying success', async status => {
  const row = await execution(await turn(), { status });
  expect((await db.query('SELECT status FROM tool_executions WHERE id=$1', [row.id])).rows[0]?.status).toBe(status);
});
it('rejects provider IDs for non-LLM origins and identical execution keys on unrelated turns', async () => {
  const t = await turn();
  const second = await turn();
  for (const origin of ['fast_path','session','internal'] as const) {
    expect(() => executionKey({ turnId: t.turn_id, chatId: chat, actorId: actor, sourceMessageId: t.source, toolName: 'x', argsHash: hash, callOrigin: origin, providerCallId: 'fake' })).toThrow();
    await expect(execution(t, { origin, provider: 'fake', key: origin })).rejects.toMatchObject({ code: '23514' });
  }
  await execution(t, { key: 'fixed-key' });
  await expect(execution(second, { key: 'fixed-key' })).rejects.toMatchObject({ code: '23505' });
});
it('preserves the raw private LID envelope and uses v1 canonical chat for ledger/artifact FKs', async () => {
  await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net')");
  await db.query("INSERT INTO user_aliases(alias,user_id,evidence) VALUES('999@lid','100@s.whatsapp.net','provider verified fixture')");
  const input = { ...msg(randomUUID(), '999@lid'), senderId: '999@lid', isGroup: false };
  expect(await receive(db, config, input)).toBe('accepted');
  const t = { turn_id: (await db.query<{ turn_id: string }>('SELECT turn_id FROM inbox')).rows[0]!.turn_id, source: input.id };
  await processNext(db, config);
  expect((await db.query('SELECT chat_id,resolved_chat_id,id FROM message_turns')).rows[0]).toEqual({ chat_id: '999@lid', resolved_chat_id: actor, id: t.turn_id });
  expect((await db.query('SELECT chat_id FROM inbox')).rows[0]?.chat_id).toBe('999@lid');
  expect((await db.query('SELECT chat_id,payload FROM outbox')).rows[0]).toMatchObject({ chat_id: actor, payload: { text: 'pong' } });
  await execution(t, { chatId: actor });
  const file = await artifact(t, { chatId: actor });
  expect((await lastChatArtifact(db, actor, actor))?.id).toBe(file.id);
  await expect(execution(t, { chatId: '999@lid', tool: 'other' })).rejects.toMatchObject({ code: '23503' });
});
