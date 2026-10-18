import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { route } from '../src/core/router.js';
import { receive } from '../src/core/inbox.js';
import { actorFor } from '../src/core/permissions.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
import { openClarificationV2 } from '../src/core/sessions-v2.js';

const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
const db = createDb(url);
const owner = '100@s.whatsapp.net';
const chat = '300@g.us';

// Real Gemini config reading actual API key from environment
process.loadEnvFile('.env');
const config = readConfig({
  ...process.env,
  DATABASE_URL: url,
  TRANSPORT: 'mock',
  EVOLUTION_URL: 'http://mock',
  OWNER_JIDS: owner,
  LAB_CHAT_ID: chat,
  ROUTER_MODE: 'v1_1',
  ROUTER_V1_1_CHAT_IDS: undefined,
  MINECRAFT_ENABLED: 'true',
  STALE_SECONDS: String(86400 * 365),
});

beforeAll(async () => {
  await migrate(db);
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await new Promise(r => setTimeout(r, 1000));
});

async function resetDb() {
  await db.query('TRUNCATE chats,users,message_turns,seen_events,inbox,outbox,jobs,notes,reminders,user_memories,context_msgs,system_flags,sessions_v2,audit_log,wallets,games,bulk_ops,tool_executions,tool_confirmations_v2,minecraft_operations CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
  await db.query("INSERT INTO users(id,display_name) VALUES($1,'Dueño')", [owner]);
  await db.query("INSERT INTO group_memberships(chat_id,user_id) VALUES($1,$2)", [chat, owner]);
  await db.query("INSERT INTO wallets(user_id,balance) VALUES($1,500)", [owner]);
}

const mockNow = new Date('2026-10-18T16:00:00.000Z'); // 10:00 AM Mexico City

async function turn(text: string, offsetMs = 0) {
  const now = new Date(mockNow.getTime() + offsetMs);
  const msg: Msg = {
    id: randomUUID(),
    chatId: chat,
    senderId: owner,
    isGroup: true,
    ts: now,
    text,
    fromMe: false,
    mentions: [],
    attachments: [],
  };
  await receive(db, config, msg, now);
  const turnRow = (await db.query<{ turn_id: string }>("SELECT turn_id FROM inbox WHERE payload->>'id'=$1", [msg.id])).rows[0];
  if (!turnRow) throw new Error('Turn row missing');
  const c = await db.connect();
  let reply: string | undefined;
  try {
    const actor = await actorFor(c, msg, config);
    const ctx: ToolCtx = {
      c,
      db,
      config,
      now,
      turnId: turnRow.turn_id,
      msg,
      actor,
      chat: { id: msg.chatId, isGroup: msg.isGroup, enabled: true, settings: {} },
      search: async () => '',
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      reply = await route(ctx);
      if (reply !== 'La IA no pudo responder en este momento. Inténtalo más tarde.') break;
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    c.release();
  }
  const sessions = (await db.query("SELECT id, kind, status, pending_tool, partial_args, missing_slots, prompt FROM sessions_v2")).rows;
  const reminders = (await db.query("SELECT id, body, due_at, status FROM reminders")).rows;
  const toolExecutions = (await db.query("SELECT tool_name, status, call_origin FROM tool_executions ORDER BY created_at ASC")).rows;
  return { reply, sessions, reminders, toolExecutions };
}

const runLive = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'fixture-gemini-key');

it.runIf(runLive)('Scenario 1 & 2: deformed reminder prompt + continuation with phonetic homophone', async () => {
  await resetDb();
  // Turn 1: "botsky guarda un rekor para las 8piem y di q estoy tontiks"
  const t1 = await turn('botsky guarda un rekor para las 8piem y di q estoy tontiks', 0);
  console.log('[SMOKE SCENARIO 1] Reply:', t1.reply);
  console.log('[SMOKE SCENARIO 1] Sessions:', JSON.stringify(t1.sessions));
  console.log('[SMOKE SCENARIO 1] Reminders:', t1.reminders.length);

  // Either a clarification session was opened, or if Gemini inferred today it created it directly.
  if (t1.sessions.length > 0 && t1.sessions[0].status === 'active') {
    expect(t1.sessions[0].pending_tool).toBe('reminders.create');
    // Turn 2: "para joi komo alas ocho piem"
    const t2 = await turn('para joi komo alas ocho piem', 60_000);
    console.log('[SMOKE SCENARIO 2] Reply:', t2.reply);
    console.log('[SMOKE SCENARIO 2] Sessions:', JSON.stringify(t2.sessions));
    console.log('[SMOKE SCENARIO 2] Reminders:', JSON.stringify(t2.reminders));
    expect(t2.reminders.length).toBeGreaterThan(0);
    expect(t2.reminders[0].body).toContain('estoy tontiks');
  } else {
    // If Gemini resolved it in one turn:
    expect(t1.reminders.length).toBeGreaterThan(0);
  }
}, 45000);

it.runIf(runLive)('Scenario 3: slot correction with natural language', async () => {
  await resetDb();
  await transaction(db, c => openClarificationV2(c, 'v1_1', {
    actorId: owner,
    chatId: chat,
    pendingTool: 'reminders.create',
    partialArgs: { body: 'estudiar', time: { kind: 'tomorrow', hour: 20, minute: 0 } },
    missingSlots: [{ kind: 'choice', field: 'date', choices: ['hoy', 'mañana'] }],
    prompt: '¿Para hoy o mañana?',
    code: 'CLARIFICATION',
    now: mockNow,
  }));

  const t3 = await turn('nel mejor el viernes como a las nueve', 60_000);
  console.log('[SMOKE SCENARIO 3] Reply:', t3.reply);
  console.log('[SMOKE SCENARIO 3] Sessions:', JSON.stringify(t3.sessions));
  console.log('[SMOKE SCENARIO 3] Reminders:', JSON.stringify(t3.reminders));
  expect(t3.reply).toBeDefined();
}, 45000);

it.runIf(runLive)('Scenario 4: intent escape during active session', async () => {
  await resetDb();
  await transaction(db, c => openClarificationV2(c, 'v1_1', {
    actorId: owner,
    chatId: chat,
    pendingTool: 'reminders.create',
    partialArgs: { body: 'estudiar', time: { kind: 'clock', hour: 20, minute: 0 } },
    missingSlots: [{ kind: 'choice', field: 'date', choices: ['hoy', 'mañana'] }],
    prompt: '¿Para hoy o mañana?',
    code: 'CLARIFICATION',
    now: mockNow,
  }));

  const t4 = await turn('cuanto xp tengo we', 60_000);
  console.log('[SMOKE SCENARIO 4] Reply:', t4.reply);
  console.log('[SMOKE SCENARIO 4] Sessions:', JSON.stringify(t4.sessions));
  console.log('[SMOKE SCENARIO 4] Executions:', JSON.stringify(t4.toolExecutions));
  expect(t4.reply).toContain('500');
  // Pending clarification session must remain active!
  expect(t4.sessions[0].status).toBe('active');
}, 45000);

it.runIf(runLive)('Scenario 5: confirmation via core_session_confirm', async () => {
  await resetDb();
  const init = await turn('reinicia minecraft', 0);
  console.log('[SMOKE SCENARIO 5 - Pre] Reply:', init.reply);
  console.log('[SMOKE SCENARIO 5 - Pre] Sessions:', JSON.stringify(init.sessions));

  const t5 = await turn('si botsky', 60_000);
  console.log('[SMOKE SCENARIO 5] Reply:', t5.reply);
  console.log('[SMOKE SCENARIO 5] Sessions:', JSON.stringify(t5.sessions));
  console.log('[SMOKE SCENARIO 5] Executions:', JSON.stringify(t5.toolExecutions));
  expect(t5.sessions[0].status).toBe('done');
}, 45000);

it.runIf(runLive)('Scenario 6: cancellation via core_session_cancel', async () => {
  await resetDb();
  const init = await turn('reinicia minecraft', 0);
  console.log('[SMOKE SCENARIO 6 - Pre] Reply:', init.reply);
  console.log('[SMOKE SCENARIO 6 - Pre] Sessions:', JSON.stringify(init.sessions));

  const t6 = await turn('nel ya estuvo', 60_000);
  console.log('[SMOKE SCENARIO 6] Reply:', t6.reply);
  console.log('[SMOKE SCENARIO 6] Sessions:', JSON.stringify(t6.sessions));
  expect(t6.sessions[0].status).toBe('cancelled');
}, 45000);
