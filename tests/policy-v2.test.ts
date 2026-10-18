import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive } from '../src/core/inbox.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { permitted } from '../src/core/permissions.js';
import { SafeRefs, type RefKind, type RefResource } from '../src/core/safe-refs.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { ToolResult } from '../src/core/tool-result.js';
import type { BackendCall } from '../src/core/policy-v2/types.js';
import { adapterAvailable } from '../src/core/policy-v2/arguments.js';
import { loadExecutionContext } from '../src/core/policy-v2/context.js';
import { evaluateToolPolicy } from '../src/core/policy-v2/evaluate.js';
import { evaluateToolV2, executeToolV2, policyDecisionDebug } from '../src/core/policy-v2/executor.js';
import * as normalization from '../src/core/policy-v2/normalize.js';
import * as minecraft from '../src/modules/minecraft/client.js';
import { product } from '../config/product.js';

const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Unsafe test database');
const db = createDb(url);
const config = readConfig({GEMINI_API_KEY:'fixture-gemini-key', DATABASE_URL: url, EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: '100@s.whatsapp.net', BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: '300@g.us', TRANSPORT: 'mock', MINECRAFT_ENABLED: 'true', ROUTER_MODE: 'v1_1' });
const owner = config.OWNER_JIDS[0]!, member = '101@s.whatsapp.net', admin = '102@s.whatsapp.net', other = '103@s.whatsapp.net';
const chat = config.LAB_CHAT_ID;
const registry = createRegistry(), catalog = createToolRegistryV2(registry);
let c: PoolClient;
const empty = () => new SafeRefs([]);
function call(safeRefMap = empty(), extra: Partial<BackendCall> = {}): BackendCall { return { callOrigin: 'fast_path', safeRefMap, ...extra }; }
async function context(actor = owner, text = 'bot ping', chatId = chat): Promise<ToolCtx> {
  const msg = { id: randomUUID(), chatId, senderId: actor, isGroup: chatId.endsWith('@g.us'), ts: new Date(), text, mentions: [], fromMe: false, attachments: [] };
  expect(await receive(db, config, msg)).toBe('accepted');
  const turn = (await db.query<{ turn_id: string }>('SELECT turn_id FROM inbox WHERE payload->>\'id\'=$1', [msg.id])).rows[0]!;
  return { turnId: turn.turn_id, msg, actor: { id: actor, role: 'member' }, chat: { id: chatId, isGroup: msg.isGroup, enabled: true, settings: {} }, db, c, config, now: new Date(), search: async () => 'mock search' };
}
async function evaluate(ctx: ToolCtx, name: string, args: unknown = {}, refs = empty()) { return (await evaluateToolV2(ctx, name, args, call(refs)))!; }
async function execute(ctx: ToolCtx, name: string, args: unknown = {}, refs = empty(), extra: Partial<BackendCall> = {}) { return executeToolV2(ctx, name, args, call(refs, extra)); }
function confirmationId(result: ToolResult): string { expect(result.status).toBe('needs_confirmation'); return (result.data as { confirmationId: string }).confirmationId; }
async function confirm(id: string, name: string, actor = owner, text = 'sí') { return execute(await context(actor, text), name, {}, empty(), { callOrigin: 'session', confirmationId: id }); }
async function note(author = owner, chatId = chat) { return (await db.query<{ id: string }>('INSERT INTO notes(chat_id,author_id,body) VALUES($1,$2,\'original\') RETURNING id', [chatId, author])).rows[0]!.id; }
function ref(kind: RefKind, id: string, chatId = chat, personalOwner?: string) {
  const resource: RefResource = { kind, id, chatId, label: 'test', access: personalOwner ? { visibility: 'personal', ownerId: personalOwner } : { visibility: 'chat' } };
  const refs = new SafeRefs([resource]);
  return { refs, token: refs.list({ chatId, actorId: personalOwner ?? owner })[0]!.ref };
}
async function count(table: string) { return (await db.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)).rows[0]!.n; }
beforeAll(() => migrate(db));
afterAll(() => db.end());
beforeEach(async () => {
  vi.restoreAllMocks();
  config.OWNER_JIDS = [owner];
  await db.query('TRUNCATE message_turns,inbox,seen_events,chats,users,system_flags,outbox,notes,reminders,user_memories,sessions,wallets,games,minecraft_operations,bulk_ops,jobs,audit_log,messaging_destinations,library_items,library_blobs,library_syncs,pack_orders,cooperachas CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true),('400@g.us',true,true),('100@s.whatsapp.net',false,true),('101@s.whatsapp.net',false,true)");
  await db.query('INSERT INTO users(id) SELECT unnest($1::text[])', [[owner, member, admin, other]]);
  await db.query('INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES($1,$2,false),($1,$3,true),($1,$4,false)', [chat, member, admin, other]);
  c = await db.connect();
});
afterEach(async () => { await c.query('ROLLBACK'); c.release(); vi.restoreAllMocks(); });

it('evaluates all gates in explicit order under a PostgreSQL READ ONLY transaction', async () => {
  const ctx = await context(member);
  await c.query('BEGIN READ ONLY');
  const d = await evaluate(ctx, 'notes.create', { body: 'hola' });
  expect(d.status).toBe('allow');
  expect(d.gates).toEqual(['system','chat','module','identity_membership','permission','safe_refs','ownership','business','economic','cooldown','confirmation']);
  expect(await count('notes')).toBe(0); expect(await count('wallets')).toBe(0);
});
it('evaluation of a destructive tool never creates confirmations, sessions or operations', async () => {
  const ctx = await context();
  await c.query('BEGIN READ ONLY');
  expect((await evaluate(ctx, 'bulk.nuclear', { text: 'hola' })).status).toBe('needs_confirmation');
  for (const table of ['tool_executions','tool_confirmations_v2','sessions','bulk_ops','jobs']) expect(await count(table)).toBe(0);
});
it('matches every historical PermissionKey without an alternate role system', async () => {
  const snapshot = JSON.parse(readFileSync('tests/fixtures/v1.1/permissions-r1.json', 'utf8')) as { permissions: Record<string, string> };
  for (const tool of catalog) expect(tool.permission).toBe(snapshot.permissions[tool.name]);
  for (const actor of [owner, member, admin]) {
    const ctx = await loadExecutionContext(await context(actor), call());
    for (const tool of catalog) {
      const legacy = registry.all().find(t => t.name === tool.name)!;
      const d = await evaluateToolPolicy(ctx, tool, legacy, {});
      if (!permitted(ctx.actor, ctx.chat, tool.permission) && d.gates.includes('permission')) expect(d.denialCode).toBe('DENIED_PERMISSION');
    }
  }
});
it.each(['emergency','maintenance'])('applies %s before any other gate, preserving owner reactivation', async flag => {
  await db.query('INSERT INTO system_flags(key,value) VALUES($1,\'true\')', [flag]);
  expect((await evaluate(await context(member), 'notes.create', { body: 'x' })).denialCode).toBe(`DENIED_${flag.toUpperCase()}`);
  expect((await evaluate(await context(), 'control.reactivate')).status).toBe('allow');
  if (flag === 'emergency') expect((await evaluate(await context(), 'notes.list')).denialCode).toBe('DENIED_EMERGENCY');
});
it('uses live chat eligibility and module state rather than supplied context', async () => {
  const ctx = await context(member);
  await db.query('UPDATE chats SET settings=\'{"modules":{"notes":false}}\' WHERE id=$1', [chat]);
  expect((await evaluate(ctx, 'notes.create', { body: 'x' })).denialCode).toBe('DENIED_MODULE_DISABLED');
  await db.query('UPDATE chats SET enabled=false WHERE id=$1', [chat]);
  expect((await evaluate(ctx, 'notes.list')).denialCode).toBe('DENIED_CHAT_DISABLED');
});
it.each(['inactive','stale'])('rejects %s membership, including a forged owner context', async state => {
  const ctx = await context(admin); ctx.actor = { id: owner, role: 'owner' };
  await db.query(state === 'inactive' ? 'UPDATE group_memberships SET active=false' : "UPDATE group_memberships SET last_seen_at=now()-interval '2 days'");
  expect((await evaluate(ctx, 'notes.list')).denialCode).toBe('DENIED_MEMBERSHIP');
});
it('blocks unresolved/conflicted LID and grants owner only through canonical backend alias evidence', async () => {
  const ctx = await context('999@lid');
  expect((await evaluate(ctx, 'minecraft.restart')).denialCode).toBe('DENIED_IDENTITY_UNRESOLVED');
  await db.query('INSERT INTO user_aliases(alias,user_id,evidence) VALUES(\'999@lid\',$1,\'verified fixture\')', [owner]);
  expect((await evaluate(ctx, 'minecraft.restart')).status).toBe('needs_confirmation');
  await db.query("UPDATE user_aliases SET evidence='conflict:fixture'");
  expect((await evaluate(ctx, 'minecraft.restart')).denialCode).toBe('DENIED_IDENTITY_UNRESOLVED');
});
it('requires current private eligibility and keeps memory.list private-only', async () => {
  const ctx = await context(member, 'bot ping', member);
  expect((await evaluate(ctx, 'memory.list')).status).toBe('allow');
  await db.query('UPDATE group_memberships SET active=false');
  expect((await evaluate(ctx, 'memory.list')).denialCode).toBe('DENIED_PRIVATE_INELIGIBLE');
  await db.query('UPDATE users SET private_ok_manual=true WHERE id=$1', [member]);
  expect((await evaluate(ctx, 'memory.list')).status).toBe('allow');
  await db.query('UPDATE group_memberships SET active=true');
  expect((await evaluate(await context(member), 'memory.list')).denialCode).toBe('DENIED_PRIVATE_ONLY');
});
it.each(['chatId','actorId','authorId','role','jid','permission','PermissionKey','confirmationHash','confirmedArgsHash','executionKey','logicalActionId','filePath','path'])('rejects model injection of %s', async field => {
  const d = await evaluate(await context(member), 'notes.create', { body: 'hola', [field]: owner });
  expect(d.denialCode).toBe('INVALID_MODEL_ARGUMENTS');
  expect(await count('notes')).toBe(0);
});
it('separates personal memory from shared notes, including fact input, without leaking raw replies', async () => {
  expect((await execute(await context(member, 'acuérdate de que me gustan los tacos'), 'memory.remember', { fact: 'me gustan los tacos' })).code).toBe('MEMORY_REMEMBER');
  expect((await execute(await context(member), 'notes.create', { body: 'comprar tortillas' })).code).toBe('NOTES_CREATE');
  expect((await db.query('SELECT user_id,body FROM user_memories')).rows).toEqual([{ user_id: member, body: 'me gustan los tacos' }]);
  expect((await db.query('SELECT chat_id,author_id,body FROM notes')).rows).toEqual([{ chat_id: chat, author_id: member, body: 'comprar tortillas' }]);
  const memories = await execute(await context(member, 'bot memoria', member), 'memory.list');
  expect(memories.code).toBe('MEMORY_LIST'); expect(JSON.stringify(memories.data)).not.toContain('@');
  const notes = await execute(await context(member), 'notes.list');
  expect(notes.code).toBe('NOTES_LIST'); expect(JSON.stringify(notes.data)).not.toContain('@');
});
it.each(['M99','A99','N1','550e8400-e29b-41d4-a716-446655440000','100@s.whatsapp.net'])('never interprets %s as a SafeRef', async value => {
  expect((await evaluate(await context(), 'notes.delete', { noteRef: value })).status).toBe('denied');
});
it('revalidates live note scope even when a trusted snapshot falsely claims the current chat', async () => {
  const id = await note(owner, '400@g.us');
  const { refs, token } = ref('noteRef', id); // Deliberately stale/mis-scoped snapshot.
  expect((await evaluate(await context(), 'notes.delete', { noteRef: token }, refs)).status).toBe('not_found');
});
it('does not resolve a genuine cross-chat snapshot or nonexistent opaque token', async () => {
  const { refs, token } = ref('noteRef', await note(owner, '400@g.us'), '400@g.us');
  expect((await evaluate(await context(), 'notes.delete', { noteRef: token }, refs)).status).toBe('not_found');
  expect((await evaluate(await context(), 'notes.delete', { noteRef: `noteRef_${randomUUID()}` })).status).toBe('not_found');
});
it.each(['reminderRef','memoryRef','opRef','driveRef','artifactRef','destinationRef'] as const)('scopes personal %s to its backend owner', async kind => {
  const { refs, token } = ref(kind, randomUUID(), chat, other);
  const ctx = await loadExecutionContext(await context(), call(refs));
  expect(refs.resolve(token, kind, ctx).status).toBe('not_found');
});
it('rejects other-user reminder and memory even when snapshot ownership is forged', async () => {
  const reminder = (await db.query<{ id: string }>("INSERT INTO reminders(chat_id,owner_id,body,due_at,timezone) VALUES($1,$2,'x',now()+interval '1 day','America/Mexico_City') RETURNING id", [chat, other])).rows[0]!.id;
  const memory = (await db.query<{ id: string }>("INSERT INTO user_memories(user_id,body) VALUES($1,'secret') RETURNING id", [other])).rows[0]!.id;
  const r = ref('reminderRef', reminder, chat, owner), m = ref('memoryRef', memory, chat, owner);
  expect((await evaluate(await context(), 'reminders.cancel', { reminderRef: r.token }, r.refs)).status).toBe('not_found');
  expect((await evaluate(await context(), 'memory.forget', { target: m.token }, m.refs)).status).toBe('not_found');
});
it('rejects unauthorized destination and other-chat operation before unsupported adapter', async () => {
  const dest = (await db.query<{ id: string }>("INSERT INTO messaging_destinations(target_id,is_group,label) VALUES('999@s.whatsapp.net',false,'no') RETURNING id")).rows[0]!.id;
  const d = ref('destinationRef', dest, chat, owner);
  expect((await evaluate(await context(), 'messaging.send', { destinations: [d.token], text: 'x' }, d.refs)).status).toBe('not_found');
  const op = (await db.query<{ id: string }>("INSERT INTO bulk_ops(kind,chat_id,actor_id,source_id,params,args_hash,expires_at) VALUES('nuclear','400@g.us',$1,'x','{}',$2,now()+interval '1 minute') RETURNING id", [owner, 'a'.repeat(64)])).rows[0]!.id;
  const o = ref('opRef', op, chat, owner);
  expect((await evaluate(await context(), 'bulk.cancel', { opRef: o.token }, o.refs)).status).toBe('not_found');
});
it.each([member, admin, owner])('notes ownership keeps historical author/superior permission for %s', async actor => {
  const { refs, token } = ref('noteRef', await note(other));
  const d = await evaluate(await context(actor), 'notes.delete', { noteRef: token }, refs);
  expect(d.status).toBe(actor === member ? 'denied' : 'needs_confirmation');
  if (actor === member) expect(d.denialCode).toBe('DENIED_OWNERSHIP');
  const own = ref('noteRef', await note(actor));
  expect((await evaluate(await context(actor), 'notes.edit', { noteRef: own.token, body: 'new' }, own.refs)).status).toBe('allow');
});
it.each([member, admin, owner])('school.task_edit keeps historical ownership rules for %s', async actor => {
  const subject = (await db.query<{ id: string }>("INSERT INTO school_subjects(chat_id,name) VALUES($1,'Mate') RETURNING id", [chat])).rows[0]!.id;
  const task = (await db.query<{ id: string }>("INSERT INTO school_tasks(chat_id,subject_id,title,created_by,source_message_id) VALUES($1,$2,'test',$3,'test') RETURNING id", [chat, subject, other])).rows[0]!.id;
  const t = ref('taskRef', task);
  expect((await evaluate(await context(actor), 'school.task_edit', { taskRef: t.token, title: 'new' }, t.refs)).status).toBe(actor === member ? 'denied' : 'allow');
});
it('requires real backend XP without creating wallet or debiting during evaluation', async () => {
  const ctx = await context(member);
  expect((await evaluate(ctx, 'games.blackjack', { bet: 50 })).denialCode).toBe('DENIED_INSUFFICIENT_XP');
  expect(await count('wallets')).toBe(0);
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,200)', [member]);
  expect((await evaluate(ctx, 'games.blackjack', { bet: 50 })).status).toBe('allow');
  expect((await db.query('SELECT balance FROM wallets')).rows[0]?.balance).toBe(200);
  expect(await count('xp_ledger')).toBe(0);
});
it('adapts reminders through SemanticTime, validates recurrence, and never opens legacy clarification', async () => {
  const ctx = await context(member);
  expect((await evaluate(ctx, 'reminders.create', { body: 'x' })).status).toBe('needs_clarification');
  expect((await evaluate(ctx, 'reminders.create', { body: 'x', time: { kind: 'tomorrow', hour: 8 } })).status).toBe('needs_clarification');
  const created = await execute(ctx, 'reminders.create', { body: 'horno', time: { kind: 'relative', amount: 10, unit: 'minute' } });
  expect(created.code).toBe('REMINDERS_CREATE'); expect(created.status).toBe('ok');
  expect((await execute(await context(member), 'reminders.list')).code).toBe('REMINDERS_LIST');
  expect(await count('sessions')).toBe(0);
});
it('replays the same webhook concurrently with a single mutation and durable result after reconnect', async () => {
  const ctx = await context(member);
  expect(await receive(db, config, ctx.msg)).toBe('duplicate');
  const [a,b] = await Promise.all([execute(ctx, 'notes.create', { body: 'once' }), execute(ctx, 'notes.create', { body: 'once' })]);
  expect(a).toEqual(b); expect(await count('notes')).toBe(1); expect(await count('tool_executions')).toBe(1);
  const restarted = createDb(url);
  try { expect(await execute({ ...ctx, db: restarted }, 'notes.create', { body: 'once' })).toEqual(a); } finally { await restarted.end(); }
});
it('returns the original result for repeated same-turn provider call id even if args/tool change', async () => {
  const ctx = await context(member), extra = { callOrigin: 'llm' as const, providerCallId: 'function_call_Exact' };
  const a = await execute(ctx, 'notes.create', { body: 'once' }, empty(), extra);
  expect(await execute(ctx, 'memory.remember', { body: 'different' }, empty(), extra)).toEqual(a);
  expect(await count('notes')).toBe(1); expect(await count('user_memories')).toBe(0);
});
it('dedupes identical effect across different provider IDs and call origins', async () => {
  const ctx = await context(member);
  const a = await execute(ctx, 'notes.create', { body: 'once' }, empty(), { callOrigin: 'llm', providerCallId: 'one' });
  expect(await execute(ctx, 'notes.create', { body: 'once' }, empty(), { callOrigin: 'llm', providerCallId: 'two' })).toEqual(a);
  expect(await execute(ctx, 'notes.create', { body: 'once' })).toEqual(a);
  expect(await count('notes')).toBe(1);
});
it('provider IDs are scoped to a turn rather than reused across unrelated messages', async () => {
  for (let i = 0; i < 2; i++) expect((await execute(await context(member), 'notes.create', { body: 'once' }, empty(), { callOrigin: 'llm', providerCallId: 'same' })).status).toBe('ok');
  expect(await count('notes')).toBe(2);
});
it('replays daily even though current policy now denies cooldown and returns typed wallet facts', async () => {
  const ctx = await context(member);
  const a = await execute(ctx, 'xp.daily');
  expect(a.status).toBe('ok'); expect(a.code).toBe('XP_DAILY');
  expect((await evaluate(ctx, 'xp.daily')).denialCode).toBe('DENIED_DAILY_COOLDOWN');
  expect(await execute(ctx, 'xp.daily')).toEqual(a); expect(await count('xp_ledger')).toBe(1);
  const balance = await execute(await context(member), 'xp.balance');
  expect(balance.code).toBe('XP_BALANCE'); expect(balance.data).toHaveProperty('balance'); expect(balance.data).toHaveProperty('level'); expect(balance.data).toHaveProperty('streak');
});
it('requires a second authenticated yes turn and preserves the immutable parent', async () => {
  const ctx = await context(), a = await execute(ctx, 'minecraft.restart'), id = confirmationId(a);
  expect(await count('minecraft_operations')).toBe(0); expect(await count('sessions')).toBe(0);
  expect((await execute(ctx, 'minecraft.restart', {}, empty(), { callOrigin: 'session', confirmationId: id })).status).toBe('needs_confirmation');
  const b = await confirm(id, 'minecraft.restart'); expect(b.status).toBe('queued');
  const rows = (await db.query('SELECT id,turn_id,status,parent_execution_id,logical_action_id FROM tool_executions ORDER BY created_at')).rows;
  expect(rows[0]?.status).toBe('needs_confirmation');
  expect(rows.at(-1)?.parent_execution_id).toBe(rows[0]?.id); expect(rows.at(-1)?.logical_action_id).toBe(rows[0]?.logical_action_id);
  expect(rows.at(-1)?.turn_id).not.toBe(rows[0]?.turn_id);
});
it.each(['actor','input','origin','expiry','module','emergency','maintenance','permission','membership','cooldown','hash'])('confirmation revalidates %s and never runs the effect on failure', async change => {
  const id = confirmationId(await execute(await context(), 'minecraft.restart'));
  let actor = owner, text = 'sí';
  if (change === 'actor') actor = member;
  if (change === 'input') text = '   ';
  if (change === 'expiry') await db.query("UPDATE tool_confirmations_v2 SET expires_at=now()-interval '1 minute'");
  if (change === 'module') await db.query('UPDATE chats SET settings=\'{"modules":{"minecraft":false}}\' WHERE id=$1', [chat]);
  if (change === 'emergency' || change === 'maintenance') await db.query('INSERT INTO system_flags(key,value) VALUES($1,\'true\')', [change]);
  if (change === 'permission' || change === 'membership') config.OWNER_JIDS = [];
  if (change === 'cooldown') await db.query("INSERT INTO minecraft_operations(id,chat_id,actor_id,source_id,request) VALUES($1,$2,$3,'busy','{}')", [randomUUID(), chat, owner]);
  if (change === 'hash') await db.query("UPDATE tool_confirmations_v2 SET resolved_args='{\"injected\":true}'");
  const ctx = await context(actor, text);
  const result = await execute(ctx, 'minecraft.restart', {}, empty(), { callOrigin: change === 'origin' ? 'fast_path' : 'session', confirmationId: id });
  // Owner retains maintenance exceptions, but an existing confirmation cannot authorize changed system state.
  expect(result.status).toBe('denied');
  expect(await count('minecraft_operations')).toBe(change === 'cooldown' ? 1 : 0);
  const history = (await db.query('SELECT id,status,parent_execution_id,logical_action_id FROM tool_executions ORDER BY created_at')).rows;
  expect(history[0]?.status).toBe('needs_confirmation');
  if (change !== 'actor') {
    expect(history.at(-1)?.parent_execution_id).toBe(history[0]?.id);
    expect(history.at(-1)?.logical_action_id).toBe(history[0]?.logical_action_id);
  }
  config.OWNER_JIDS = [owner];
});
it('duplicate confirmation across concurrent distinct yes turns returns the persisted result once', async () => {
  const id = confirmationId(await execute(await context(), 'minecraft.restart'));
  const [a,b] = await Promise.all([confirm(id, 'minecraft.restart'), confirm(id, 'minecraft.restart')]);
  expect(a.status).toBe('queued'); expect(b).toEqual(a); expect(await count('minecraft_operations')).toBe(1);
});
it('changed note contents invalidate its confirmation and a completed deletion is replayed despite a stale ref', async () => {
  const n = await note(member), r = ref('noteRef', n);
  const a = await execute(await context(member), 'notes.delete', { noteRef: r.token }, r.refs);
  await db.query("UPDATE notes SET body='changed' WHERE id=$1", [n]);
  expect((await confirm(confirmationId(a), 'notes.delete', member)).code).toBe('DENIED_CONFIRMATION_ARGS_CHANGED');
  const b = await execute(await context(member), 'notes.delete', { noteRef: r.token }, r.refs);
  const yes = await context(member, 'sí');
  const extra = { callOrigin: 'session' as const, confirmationId: confirmationId(b) };
  const done = await execute(yes, 'notes.delete', {}, empty(), extra);
  expect(done.status).toBe('ok'); expect(done.code).toBe('NOTES_DELETE');
  expect(await execute(yes, 'notes.delete', {}, empty(), extra)).toEqual(done);
  expect((await db.query('SELECT deleted_at FROM notes WHERE id=$1', [n])).rows[0]?.deleted_at).not.toBeNull();
});
it.each([member, admin, owner])('Nuclear matrix for %s: owner-only with confirmation before operations', async actor => {
  const a = await execute(await context(actor), 'bulk.nuclear', { text: 'hola', count: 8 });
  expect(a.status).toBe(actor === owner ? 'needs_confirmation' : 'denied');
  if (actor !== owner) expect(a.code).toBe('DENIED_PERMISSION');
  expect(await count('bulk_ops')).toBe(0); expect(await count('jobs')).toBe(0); expect(await count('outbox')).toBe(0);
  if (actor === owner) {
    expect((await confirm(confirmationId(a), 'bulk.nuclear')).status).toBe('queued');
    expect(await count('bulk_ops')).toBe(1); expect(await count('bulk_targets')).toBe(8); expect(await count('jobs')).toBe(1);
    expect(await count('sessions')).toBe(0); expect(await count('outbox')).toBe(0);
    expect((await db.query('SELECT DISTINCT target_id FROM bulk_targets')).rows).toEqual([{ target_id: chat }]);
  }
});
it.each([4,5,8,10,11])('Nuclear accepts only 5–10 messages (%i)', async count => {
  const d = await evaluate(await context(), 'bulk.nuclear', { text: 'hola', count });
  expect(d.status).toBe(count >= 5 && count <= 10 ? 'needs_confirmation' : 'denied');
});
it('Nuclear defaults to 8 and restricts scope, cooldown 10min and maximum 2/hour', async () => {
  expect(product.nuclearCooldownMs).toBe(600_000); expect(product.nuclearHourlyOps).toBe(2);
  const d = await evaluate(await context(), 'bulk.nuclear', { text: 'hola' }); expect(d.resolvedArgs.count).toBe(8);
  expect((await evaluate(await context(owner, 'bot ping', owner), 'bulk.nuclear', { text: 'hola' })).denialCode).toBe('DENIED_CHAT_SCOPE');
  const id = confirmationId(await execute(await context(), 'bulk.nuclear', { text: 'hola' }));
  expect((await confirm(id, 'bulk.nuclear')).status).toBe('queued');
  expect((await evaluate(await context(), 'bulk.nuclear', { text: 'hola' })).denialCode).toBe('DENIED_NUCLEAR_COOLDOWN');
  await db.query("UPDATE bulk_ops SET status='done',confirmed_at=now()-interval '11 minutes'");
  const id2 = confirmationId(await execute(await context(), 'bulk.nuclear', { text: 'hola' }));
  expect((await confirm(id2, 'bulk.nuclear')).status).toBe('queued');
  await db.query("UPDATE bulk_ops SET status='done',confirmed_at=now()-interval '11 minutes'");
  expect((await evaluate(await context(), 'bulk.nuclear', { text: 'hola' })).denialCode).toBe('DENIED_NUCLEAR_HOURLY');
});
it.each([member, admin, owner])('Minecraft matrix for %s uses exact historical permissions', async actor => {
  expect((await evaluate(await context(actor), 'minecraft.status')).status).toBe('allow');
  expect((await evaluate(await context(actor), 'minecraft.restart')).status).toBe(actor === owner ? 'needs_confirmation' : 'denied');
});
it('normalizes Minecraft status through a mocked legacy client without touching SSH', async () => {
  const mock = vi.spyOn(minecraft, 'callMinecraft').mockImplementation(async (request, id) => ({ v: 1, id: id ?? randomUUID(), action: request.action, ok: true, code: 'ok', data: { online: true, running: true, startedAt: 'fixture', uptimeSeconds: 12, players: 1, maxPlayers: 10 } }));
  const r = await execute(await context(member), 'minecraft.status');
  expect(r.status).toBe('ok'); expect(r.code).toBe('MINECRAFT_STATUS'); expect(mock).toHaveBeenCalledOnce();
});
it('normalizes games and media without replacing domain transactions or workers', async () => {
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,200)', [member]);
  const game = await execute(await context(member), 'games.blackjack', { bet: 50, table: true });
  expect(game.status).toBe('ok'); expect(game.code).toBe('GAMES_BLACKJACK');
  expect((await execute(await context(member), 'games.status')).code).toBe('GAMES_STATUS');
  expect((await execute(await context(member), 'media.status')).code).toBe('MEDIA_STATUS');
  expect(await count('xp_ledger')).toBe(1);
});
it('normalizes polls, checks closed refs, textual options and polls.manage parity', async () => {
  const poll = (await db.query<{ id: string }>("INSERT INTO polls(chat_id,author_id,source_id,question,closes_at) VALUES($1,$2,'poll','tacos?',now()+interval '1 hour') RETURNING id", [chat, owner])).rows[0]!.id;
  await db.query("INSERT INTO poll_options(poll_id,idx,label) VALUES($1,1,'Sí'),($1,2,'No')", [poll]);
  const p = ref('pollRef', poll);
  const vote = await execute(await context(member), 'polls.vote', { pollRef: p.token, option: 'Sí' }, p.refs);
  expect(vote.code).toBe('POLLS_VOTE'); expect(vote.status).toBe('ok');
  expect((await execute(await context(member), 'polls.results', { pollRef: p.token }, p.refs)).code).toBe('POLLS_RESULTS');
  expect((await evaluate(await context(member), 'polls.close', { pollRef: p.token }, p.refs)).denialCode).toBe('DENIED_PERMISSION');
  await db.query("UPDATE polls SET status='closed'");
  expect((await evaluate(await context(member), 'polls.vote', { pollRef: p.token, option: 1 }, p.refs)).denialCode).toBe('DENIED_POLL_CLOSED');
});
it.each(['v1','v1_1_shadow'] as const)('%s execution entry remains observational with zero v2 side effects', async mode => {
  const ctx = { ...await context(), config: { ...config, ROUTER_MODE: mode } };
  await c.query('BEGIN READ ONLY');
  for (const [tool,args] of [['notes.create',{ body: 'x' }],['memory.remember',{ body: 'x' }],['xp.daily',{}],['bulk.nuclear',{ text: 'hola' }],['minecraft.restart',{}]] as const) {
    expect((await execute(ctx, tool, args)).code).toBe('DENIED_EXECUTION_MODE');
  }
  for (const table of ['notes','user_memories','reminders','tool_executions','tool_confirmations_v2','sessions','jobs','bulk_ops','minecraft_operations','wallets']) expect(await count(table)).toBe(0);
});
it('keeps an uncertain execution uncertain and replays its receipt without a second mutation', async () => {
  const ctx = await context(member);
  vi.spyOn(normalization, 'normalizeLegacyResult').mockResolvedValueOnce({ status: 'uncertain', toolName: 'notes.create', domain: 'productivity', code: 'EXTERNAL_UNCERTAIN', data: {} });
  expect((await execute(ctx, 'notes.create', { body: 'once' })).status).toBe('uncertain');
  expect((await execute(ctx, 'notes.create', { body: 'once' })).status).toBe('uncertain'); expect(await count('notes')).toBe(1);
});

it('rolls back a real process death after INSERT before commit, then retries once', async () => {
  const ctx = await context(member);
  await c.query("SELECT pg_advisory_lock(hashtext('r3-crash-barrier'))");
  await db.query(`CREATE FUNCTION r3_crash_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(hashtext('r3-crash-barrier')); RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER r3_crash_barrier AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION r3_crash_barrier()');
  const child = spawn(process.execPath, ['--import','tsx','tests/policy-runtime-child.ts',ctx.turnId!, 'precommit'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      blocked = Boolean((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='r3-policy-crash' AND wait_event='advisory'")).rowCount);
      if (blocked) break;
      await delay(25);
    }
    expect(blocked).toBe(true); child.kill('SIGKILL'); await exited;
  } finally {
    child.kill('SIGKILL');
    await c.query("SELECT pg_advisory_unlock(hashtext('r3-crash-barrier'))");
    await db.query('DROP TRIGGER r3_crash_barrier ON notes');
    await db.query('DROP FUNCTION r3_crash_barrier()');
  }
  expect(await count('notes')).toBe(0); expect(await count('tool_executions')).toBe(0);
  expect((await execute(ctx, 'notes.create', { body: 'crash-fixture' })).status).toBe('ok');
  expect(await count('notes')).toBe(1);
});
it('recovers a committed receipt after actual process death before responding', async () => {
  const ctx = await context(member);
  const child = spawn(process.execPath, ['--import','tsx','tests/policy-runtime-child.ts',ctx.turnId!, 'postcommit'], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit');
  expect(code).toBeNull(); expect(signal).toBe('SIGKILL');
  expect(await count('notes')).toBe(1); expect(await count('tool_executions')).toBe(1);
  const stored = (await db.query('SELECT result_json FROM tool_executions')).rows[0]!.result_json;
  expect(await execute(ctx, 'notes.create', { body: 'crash-fixture' })).toEqual(stored);
  expect(await count('notes')).toBe(1);
});
it('rolls back handler writes when result normalization fails and persists a replayable error', async () => {
  const ctx = await context(member);
  vi.spyOn(normalization, 'normalizeLegacyResult').mockRejectedValueOnce(new Error('fixture failure'));
  const failed = await execute(ctx, 'notes.create', { body: 'rollback' });
  expect(failed.status).toBe('error'); expect(failed.code).toBe('HANDLER_ERROR');
  expect(await count('notes')).toBe(0); expect(await count('tool_executions')).toBe(1);
  expect(await execute(ctx, 'notes.create', { body: 'rollback' })).toEqual(failed);
  expect(await count('notes')).toBe(0);
});

it('revalidates personal-memory refs and binds the current memory set across confirmation', async () => {
  const id = (await db.query<{ id: string }>("INSERT INTO user_memories(user_id,body) VALUES($1,'tacos') RETURNING id", [member])).rows[0]!.id;
  const m = ref('memoryRef', id, chat, member);
  const first = await execute(await context(member), 'memory.forget', { target: m.token }, m.refs);
  expect((await confirm(confirmationId(first), 'memory.forget', member)).status).toBe('ok');
  expect(await count('user_memories')).toBe(0);
  await db.query("INSERT INTO user_memories(user_id,body) VALUES($1,'original')", [member]);
  const all = await execute(await context(member), 'memory.forget', { target: 'all' });
  await db.query("INSERT INTO user_memories(user_id,body) VALUES($1,'added after preview')", [member]);
  expect((await confirm(confirmationId(all), 'memory.forget', member)).code).toBe('DENIED_CONFIRMATION_ARGS_CHANGED');
  expect(await count('user_memories')).toBe(2);
});
it('does not accept confirmation handles from a different chat', async () => {
  const id = confirmationId(await execute(await context(), 'minecraft.restart'));
  const ctx = await context(owner, 'sí', '400@g.us');
  expect((await execute(ctx, 'minecraft.restart', {}, empty(), { callOrigin: 'session', confirmationId: id })).code).toBe('DENIED_CONFIRMATION_NOT_FOUND');
  expect(await count('minecraft_operations')).toBe(0);
});
it('logs only the explicit policy-debug allowlist, excluding args, IDs, paths and hashes', async () => {
  const ctx = await loadExecutionContext(await context(member, 'acuérdate de que me gustan los tacos'), call());
  const d = await evaluateToolPolicy(ctx, catalog.find(t => t.name === 'memory.remember')!, registry.all().find(t => t.name === 'memory.remember')!, { body: 'me gustan los tacos' });
  const debug = policyDecisionDebug(ctx, 'memory.remember', 'productivity', d, 12);
  expect(Object.keys(debug).sort()).toEqual(['selectedTool','domain','policyDecision','denialCode','requiredConfirmation','toolExposureCount','callOrigin'].sort());
  expect(JSON.stringify(debug)).not.toMatch(/tacos|@|argsHash|confirmationHash|actorId|chatId|\/home\/|\/data\//iu);
  expect(debug.toolExposureCount).toBe(12);
});
it('keeps legacy entry points free of direct executor bypass and exposes no handler', () => {
  for (const file of ['router','router-shadow','sessions','llm','inbox','runtime']) {
    expect(readFileSync(`src/core/${file}.ts`, 'utf8')).not.toContain('policy-v2/executor');
  }
  expect(readFileSync('src/worker.ts', 'utf8')).not.toContain('policy-v2/executor');
  expect(Object.keys(catalog[0]!)).not.toContain('run');
});
it('ignores forged caller sender/chat/role and takes identity from the authenticated turn', async () => {
  const ctx = await context(member);
  ctx.msg.senderId = owner; ctx.actor = { id: owner, role: 'owner' }; ctx.chat.id = '400@g.us';
  expect((await execute(ctx, 'notes.create', { body: 'backend identity' })).status).toBe('ok');
  expect((await db.query('SELECT chat_id,author_id FROM notes')).rows).toEqual([{ chat_id: chat, author_id: member }]);
});
it('preserves literal content resembling a reference instead of rewriting exact user text', async () => {
  const n = ref('noteRef', await note(other));
  const r = await execute(await context(member), 'notes.create', { body: n.token }, n.refs);
  expect(r.status).toBe('ok');
  expect((await db.query('SELECT body FROM notes ORDER BY id DESC LIMIT 1')).rows[0]?.body).toBe(n.token);
});
it('checks artifact ownership, expiry and real backing; A_LAST is backend scoped', async () => {
  const ctx = await context(member);
  const backing = (await db.query<{ id: string }>(`INSERT INTO media_attachments(chat_id,owner_id,is_original,mime,extension,size,sha256,data,expires_at)
    VALUES($1,$2,false,'application/pdf','pdf',9,$3,$4,now()+interval '1 hour') RETURNING id`, [chat, member, 'a'.repeat(64), Buffer.from('%PDF-test')])).rows[0]!.id;
  const artifact = (await db.query<{ id: string }>(`INSERT INTO chat_artifacts(chat_id,actor_id,turn_id,source_message_id,media_attachment_id,kind,mime,expires_at)
    VALUES($1,$2,$3,$4,$5,'pdf','application/pdf',now()+interval '1 hour') RETURNING id`, [chat, member, ctx.turnId, ctx.msg.id, backing])).rows[0]!.id;
  const r = ref('artifactRef', artifact, chat, member);
  const last = await evaluate(ctx, 'media.process', { operation: 'pdf_compress', artifactRef: 'A_LAST' });
  expect(last.resolvedSafeRefs).toEqual([{ ref: 'A_LAST', kind: 'artifactRef', id: artifact }]);
  expect(last.status).toBe('allow'); expect(last.denialCode).toBeNull();
  const forged = ref('artifactRef', artifact, chat, owner);
  expect((await evaluate(await context(), 'media.process', { operation: 'pdf_compress', artifactRef: forged.token }, forged.refs)).status).toBe('not_found');
  await db.query('UPDATE media_attachments SET data=NULL WHERE id=$1', [backing]);
  expect((await evaluate(ctx, 'media.process', { operation: 'pdf_compress', artifactRef: r.token }, r.refs)).status).toBe('not_found');
});
it('prevents nested identity injection and validates reminder recurrence before creating any session', async () => {
  const ctx = await context(member);
  const injected = await evaluate(ctx, 'reminders.create', { body: 'x', time: { kind: 'relative', amount: 1, unit: 'day', actorId: owner } });
  expect(injected.denialCode).toBe('INVALID_MODEL_ARGUMENTS');
  const mismatch = await evaluate(ctx, 'reminders.create', { body: 'x', time: { kind: 'tomorrow', hour: 8, meridiem: 'am' }, recurrence: { kind: 'daily', hour: 10, minute: 0 } });
  expect(mismatch.denialCode).toBe('INVALID_RECURRENCE');
  expect(await count('sessions')).toBe(0); expect(await count('reminders')).toBe(0);
});
it('offers all 96 public adapters and keeps only two internal mechanisms closed', () => {
  const blocked = catalog.filter(t => !adapterAvailable(t.name)).map(t => t.name).sort();
  expect(blocked).toEqual(['bulk.confirm','school.schedule_commit'].sort());
  expect(catalog.filter(t => adapterAvailable(t.name))).toHaveLength(96);
});
it('adapts safe legacy contracts without rewriting their domain implementation', async () => {
  expect((await execute(await context(), 'control.modules', { module: 'notes', enabled: false })).status).toBe('ok');
  expect((await evaluate(await context(), 'notes.list')).denialCode).toBe('DENIED_MODULE_DISABLED');
  expect((await execute(await context(admin), 'xp.happy', { minutes: 15 })).code).toBe('LEGACY_ADAPTER_OK');
  expect((await execute(await context(member), 'moderation.warns')).status).toBe('ok');
  const web = await execute(await context(member), 'web.search', { query: 'fixture' });
  expect(web.status).toBe('ok'); expect(web.code).toBe('WEB_SEARCH');
});
it.each(['messaging.send','bulk.broadcast'])('%s uses SafeRef destinations and the same two-turn atomic queue service', async name => {
  const destination = (await db.query<{ id: string }>("INSERT INTO messaging_destinations(target_id,is_group,label) VALUES($1,true,'Lab') RETURNING id", [chat])).rows[0]!.id;
  const r = ref('destinationRef', destination, chat, owner);
  const a = await execute(await context(), name, { destinations: [r.token], text: 'exact fixture' }, r.refs);
  expect(await count('bulk_ops')).toBe(0);
  const queued = await confirm(confirmationId(a), name);
  expect(queued.status).toBe('queued'); expect(queued.data).toHaveProperty('count', 1);
  expect(await count('bulk_targets')).toBe(1); expect(await count('sessions')).toBe(0); expect(await count('outbox')).toBe(0);
});
it('revalidates destination authorization after the first turn and never queues a revoked target', async () => {
  const destination = (await db.query<{ id: string }>("INSERT INTO messaging_destinations(target_id,is_group,label) VALUES($1,true,'Lab') RETURNING id", [chat])).rows[0]!.id;
  const r = ref('destinationRef', destination, chat, owner);
  const a = await execute(await context(), 'messaging.send', { destinations: [r.token], text: 'fixture' }, r.refs);
  await db.query("UPDATE messaging_destinations SET target_id='999@s.whatsapp.net',is_group=false WHERE id=$1", [destination]);
  expect((await confirm(confirmationId(a), 'messaging.send')).status).toBe('not_found');
  expect(await count('bulk_ops')).toBe(0);
});
it('Drive adapters use own live entries, durable jobs and historical admission limits without remote calls', async () => {
  await db.query("UPDATE chats SET settings='{\"drive\":true}' WHERE id=$1", [chat]);
  const ctx = await context(member); ctx.config = { ...config, DRIVE_ENABLED: true };
  const q = await execute(ctx, 'drive.search', { query: 'fixture' });
  expect(q.status).toBe('queued'); expect(q.code).toBe('LEGACY_JOB_QUEUED');
  const entry = (await db.query<{ id: string }>(`INSERT INTO drive_entries(chat_id,actor_id,remote_id,name,mime,size,expires_at)
    VALUES($1,$2,'fixture-remote','fixture','application/pdf',20,now()+interval '1 hour') RETURNING id`, [chat, member])).rows[0]!.id;
  const r = ref('driveRef', entry, chat, member);
  const download = await context(member); download.config = ctx.config;
  expect((await execute(download, 'drive.download', { driveRef: r.token }, r.refs)).status).toBe('queued');
  const capped = await context(member); capped.config = ctx.config;
  expect((await evaluate(capped, 'drive.search', { query: 'fixture' })).denialCode).toBe('DENIED_JOB_LIMIT');
  expect(await count('jobs')).toBe(2); expect(await count('outbox')).toBe(0);
});
it('economic eligibility reads real balances for packs, roulette, join and double', async () => {
  const ctx = await context(member);
  expect((await evaluate(ctx, 'packs.buy')).denialCode).toBe('DENIED_INSUFFICIENT_XP');
  expect((await evaluate(ctx, 'games.roulette', { bet: 50 })).denialCode).toBe('DENIED_INSUFFICIENT_XP');
  expect((await evaluate(ctx, 'games.play', { move: 'doblar' })).denialCode).toBe('DENIED_GAME_NOT_FOUND');
  expect((await evaluate(ctx, 'cooperacha.contribute', { amount: 10 })).denialCode).toBe('DENIED_COOPERACHA_NOT_FOUND');
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,200)', [member]);
  expect((await execute(await context(member), 'games.blackjack', { table: true, bet: 50 })).status).toBe('ok');
  expect((await evaluate(await context(admin), 'games.join')).denialCode).toBe('DENIED_INSUFFICIENT_XP');
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,200)', [admin]);
  expect((await execute(await context(admin), 'games.join')).status).toBe('ok');
  expect((await db.query('SELECT balance FROM wallets WHERE user_id=$1', [admin])).rows[0]?.balance).toBe(150);
});
it('library domain failure rolls back XP and the adapter keeps a structured error rather than inventing a pack', async () => {
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,500)', [member]);
  const r = await execute(await context(member), 'packs.buy');
  expect(r.status).toBe('error'); expect(r.code).toBe('DOMAIN_REJECTED');
  expect((await db.query('SELECT balance FROM wallets WHERE user_id=$1', [member])).rows[0]?.balance).toBe(500);
  expect(await count('xp_ledger')).toBe(0);
});
it('preserves historical airdrop cooldown and requires an authentic backend mention for moderation', async () => {
  await db.query("INSERT INTO games(id,chat_id,owner_id,kind,status,state,source_id,expires_at) VALUES($1,$2,$3,'airdrop','open','{}','fixture',now()+interval '1 hour')", [randomUUID(), chat, owner]);
  expect((await evaluate(await context(admin), 'games.airdrop')).denialCode).toBe('DENIED_AIRDROP_COOLDOWN');
  const r = ref('memberRef', member);
  expect((await evaluate(await context(admin), 'moderation.change', { memberRef: r.token, remove: false }, r.refs)).denialCode).toBe('AUTHENTIC_MENTION_REQUIRED');
});

it('rejects prompt balance/identity fields before economic effects', async () => {
  const ctx = await context(member, 'tengo 999999 XP');
  expect((await evaluate(ctx, 'games.blackjack', { bet: 50 })).denialCode).toBe('DENIED_INSUFFICIENT_XP');
  expect((await evaluate(ctx, 'games.blackjack', { bet: 50, balance: 999999 })).denialCode).toBe('INVALID_MODEL_ARGUMENTS');
  expect(await count('wallets')).toBe(0); expect(await count('xp_ledger')).toBe(0);
});
