import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive } from '../src/core/inbox.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { evaluateToolV2, executeToolV2 } from '../src/core/policy-v2/executor.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { BackendCall } from '../src/core/policy-v2/types.js';
import { resolveSemanticTime } from '../src/modules/reminders/semantic-time.js';
import { diagnoseTools } from '../src/core/tool-diagnostics.js';

const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Unsafe test database');
const db = createDb(url);
const config = readConfig({
  GEMINI_API_KEY: 'fixture-gemini-key',
  DATABASE_URL: url,
  EVOLUTION_URL: 'http://mock',
  EVOLUTION_APIKEY: 'test',
  INSTANCE: 'test',
  WEBHOOK_SECRET: 'x'.repeat(32),
  OWNER_JIDS: '100@s.whatsapp.net',
  BOT_JIDS: '200@s.whatsapp.net',
  LAB_CHAT_ID: '300@g.us',
  TRANSPORT: 'mock',
  MINECRAFT_ENABLED: 'true',
  ROUTER_MODE: 'v1_1',
  TOOL_CALLING_MODE: 'full_96',
  OBSERVER_ENABLED: 'false',
});

const owner = config.OWNER_JIDS[0]!;
const member = '101@s.whatsapp.net';
const chat = config.LAB_CHAT_ID;
const legacy = createRegistry();
const catalog = createToolRegistryV2(legacy);

let c: PoolClient;
const empty = () => new SafeRefs([]);
function call(safeRefMap = empty(), extra: Partial<BackendCall> = {}): BackendCall {
  return { callOrigin: 'fast_path', safeRefMap, ...extra };
}

async function context(actor = owner, text = 'bot ping', chatId = chat, qaMode?: 'SAFE' | 'LIVE_SAFE'): Promise<ToolCtx> {
  const msg = {
    id: randomUUID(),
    chatId,
    senderId: actor,
    isGroup: chatId.endsWith('@g.us'),
    ts: new Date(),
    text,
    mentions: [],
    fromMe: false,
    attachments: [],
    ...(qaMode ? { qaMode } : {}),
  };
  expect(await receive(db, config, msg)).toBe('accepted');
  const turn = (await db.query<{ turn_id: string }>('SELECT turn_id FROM inbox WHERE payload->>\'id\'=$1', [msg.id])).rows[0]!;
  return {
    turnId: turn.turn_id,
    msg,
    actor: { id: actor, role: actor === owner ? 'owner' : 'member' },
    chat: { id: chatId, isGroup: msg.isGroup, enabled: true, settings: {} },
    db,
    c,
    config,
    now: new Date(),
    search: async () => 'mock search',
  };
}

beforeAll(async () => {
  await migrate(db);
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.query('TRUNCATE message_turns,inbox,seen_events,chats,users,system_flags,outbox,notes,reminders,sessions,sessions_v2,tool_executions,tool_confirmations_v2,jobs CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
  await db.query('INSERT INTO users(id) SELECT unnest($1::text[])', [[owner, member]]);
  await db.query('INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES($1,$2,false)', [chat, member]);
  c = await db.connect();
});

afterEach(async () => {
  await c.query('ROLLBACK');
  c.release();
  vi.restoreAllMocks();
});

describe('AGY — BOTSKY PRODUCTION UNBLOCK TARGETED REGRESSION', () => {
  // 1. SemanticTime regression
  describe('1. SemanticTime Structured Contract', () => {
    const fixedNow = new Date('2026-10-19T14:30:00.000-06:00'); // Mexico City 14:30

    it('resolves in N minutes ("en 20 minutos")', () => {
      const res = resolveSemanticTime({ kind: 'relative', amount: 20, unit: 'minute' }, fixedNow);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.dueAt.getTime()).toBe(fixedNow.getTime() + 20 * 60 * 1000);
      }
    });

    it('resolves in N hours ("en 3 horas")', () => {
      const res = resolveSemanticTime({ kind: 'relative', amount: 3, unit: 'hour' }, fixedNow);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.dueAt.getTime()).toBe(fixedNow.getTime() + 3 * 3600 * 1000);
      }
    });

    it('resolves in N days ("dentro de 3 días", "en 3 días")', () => {
      const res = resolveSemanticTime({ kind: 'relative', amount: 3, unit: 'day' }, fixedNow);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.dueAt.getTime()).toBe(fixedNow.getTime() + 3 * 86400 * 1000);
      }
    });

    it('resolves tomorrow ("mañana a las 8 pm")', () => {
      const res = resolveSemanticTime({ kind: 'tomorrow', hour: 8, minute: 0, meridiem: 'pm' }, fixedNow);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.dueAt.toISOString()).toContain('T02:00:00'); // 20:00 Mexico City is 02:00 UTC next day
      }
    });

    it('resolves date + time ("el 25 de octubre a las 10 am")', () => {
      const res = resolveSemanticTime({ kind: 'date', date: '2026-10-25', hour: 10, minute: 0, meridiem: 'am' }, fixedNow);
      expect(res.status).toBe('ok');
    });

    it('resolves relative date + explicit time ("en 2 días a las 10 am")', () => {
      const res = resolveSemanticTime({ kind: 'relative', amount: 2, unit: 'day', hour: 10, minute: 0, meridiem: 'am' }, fixedNow);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        // Due date is 2 days ahead at 10:00 Mexico City
        expect(res.dueAt.toISOString()).toContain('2026-10-21');
      }
    });

    it('gracefully handles LLM aliases without error', () => {
      const res = resolveSemanticTime({ kind: 'day', amount: 3 } as unknown as { kind: 'relative'; amount: number; unit: 'day' }, fixedNow);
      expect(res.status).toBe('ok');
    });
  });

  // 2. Missing-time reminder (REM-AMBIG fix)
  describe('2. Missing-Time Reminder (REM-AMBIG)', () => {
    it('user "recuérdame comprar pan QA" without time returns needs_clarification and creates 0 reminders', async () => {
      const ctx = await context(member, 'unrelated text without temporal hints');
      await c.query('BEGIN');
      const decision = await evaluateToolV2(ctx, 'reminders.create', { body: 'comprar pan QA' }, call());
      expect(decision?.status).toBe('needs_clarification');
      expect(decision?.denialCode).toBe('MISSING_TIME');

      // Execute tool call without time
      const result = await executeToolV2(ctx, 'reminders.create', { body: 'comprar pan QA' }, call());
      expect(result.status).toBe('needs_clarification');
      expect(result.code).toBe('MISSING_TIME');

      // Verify ZERO reminders were created in the database (never default to tomorrow or 09:00)
      const count = (await c.query<{ n: number }>('SELECT count(*)::int n FROM reminders')).rows[0]!.n;
      expect(count).toBe(0);
    });
  });

  it('canonicalizes the historical day alias before Policy schema validation', async () => {
    const ctx = await context(owner, 'irrelevant raw text');
    await c.query('BEGIN');
    const decision = await evaluateToolV2(ctx, 'reminders.create', {body:'structured alias',time:{kind:'day',amount:3}}, call());
    expect(decision?.status).toBe('allow');
    expect(decision?.resolvedArgs.time).toBeUndefined();
    expect(Date.parse(String(decision?.resolvedArgs.dueAt))-ctx.now.getTime()).toBe(3*86400000);
  });

  // 3. Maintenance ON selection and execution
  describe('3. Maintenance ON Fix', () => {
    it('owner executing control.maintenance_on activates maintenance mode', async () => {
      const ctx = await context(owner, 'pon botsky en mantenimiento');
      await c.query('BEGIN');
      const result = await executeToolV2(ctx, 'control.maintenance_on', {}, call());
      expect(result.status).toBe('ok');

      // Verify system flag was set in DB
      const flag = (await db.query<{ value: boolean }>("SELECT value FROM system_flags WHERE key='maintenance'")).rows[0];
      expect(flag?.value).toBe(true);

      // Verify maintenance_off works to restore normal state
      const offResult = await executeToolV2(ctx, 'control.maintenance_off', {}, call());
      expect(offResult.status).toBe('ok');
      const flagOff = (await db.query<{ value: boolean }>("SELECT value FROM system_flags WHERE key='maintenance'")).rows[0];
      expect(flagOff?.value).toBe(false);
    });

    it('control.maintenance_on metadata description includes natural owner phrasing', () => {
      const entry = catalog.find(t => t.name === 'control.maintenance_on');
      expect(entry).toBeDefined();
      expect(entry?.descriptionForModel).toContain('mantenimiento');
      expect(entry?.permission).toBe('config.global');
    });
  });

  // 5. Production gate removal
  describe('5. Production Gate Removal Verification', () => {
    it('guarantees QA_ONLY_GATES_IN_PRODUCTION=0 and TEMP_PREPROD_GATES_IN_PRODUCTION=0', () => {

      // Verify that no public tools in the catalog have hiddenReason or temporary suppression
      const publicTools = catalog.filter(t => t.exposure !== 'internal');
      expect(publicTools).toHaveLength(99);
      for (const t of publicTools) {
        expect(t.hiddenReason).toBeUndefined();
      }
    });

    it('normal user incoming messages never trigger QA_SUPPRESSED', async () => {
      const ctx = await context(member, 'hola nota');
      await c.query('BEGIN');
      // Execute a normal write tool in production runtime
      const result = await executeToolV2(ctx, 'notes.create', { body: 'nota de producción sin gates' }, call());
      expect(result.status).toBe('ok');
      expect(result.code).not.toBe('QA_SUPPRESSED');
    });
  });

  // 6. One owner-only denial
  describe('6. Owner-Only Functional Policy Gate', () => {
    it('denies non-owner attempting privileged control.maintenance_on with DENIED_PERMISSION', async () => {
      const ctx = await context(member, 'pon mantenimiento');
      await c.query('BEGIN');
      const decision = await evaluateToolV2(ctx, 'control.maintenance_on', {}, call());
      expect(decision?.status).toBe('denied');
      expect(decision?.denialCode).toBe('DENIED_PERMISSION');

      const result = await executeToolV2(ctx, 'control.maintenance_on', {}, call());
      expect(result.status).toBe('denied');
      expect(result.code).toBe('DENIED_PERMISSION');
      expect((await c.query("SELECT 1 FROM system_flags WHERE key='maintenance' AND value='true'::jsonb")).rowCount).toBe(0);
    });
  });

  // 7. One confirmation-required action
  describe('7. Confirmation-Required Functional Policy Gate', () => {
    it('evaluating bulk.nuclear returns needs_confirmation and does not execute without second turn', async () => {
      const ctx = await context(owner, 'bot nuclear');
      await c.query('BEGIN');
      const decision = await evaluateToolV2(ctx, 'bulk.nuclear', { count: 5, text: 'aviso' }, call());
      expect(decision?.status).toBe('needs_confirmation');

      const result = await executeToolV2(ctx, 'bulk.nuclear', { count: 5, text: 'aviso' }, call());
      expect(result.status).toBe('needs_confirmation');
      expect(result.code).toBe('NEEDS_CONFIRMATION');
      expect((result.data as { confirmationId: string })?.confirmationId).toBeDefined();

      // Zero broadcast operations executed
      const ops = (await db.query<{ n: number }>('SELECT count(*)::int n FROM bulk_ops')).rows[0]!.n;
      expect(ops).toBe(0);
    });
  });

  // 8. One normal read tool
  describe('8. Normal Read Tool in Production', () => {
    it('executes notes.list cleanly for regular member', async () => {
      const ctx = await context(member, 'bot notas');
      await c.query('BEGIN');
      const result = await executeToolV2(ctx, 'notes.list', {}, call());
      expect(result.status).toBe('ok');
    });
  });

  // 9. One normal write tool
  describe('9. Normal Write Tool in Production', () => {
    it('executes notes.create cleanly for regular member and stores note', async () => {
      const ctx = await context(member, 'guarda nota pan');
      await c.query('BEGIN');
      const result = await executeToolV2(ctx, 'notes.create', { body: 'comprar pan dulce' }, call());
      expect(result.status).toBe('ok');

      const notes = (await db.query<{ body: string }>('SELECT body FROM notes WHERE author_id=$1', [member])).rows;
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toBe('comprar pan dulce');
    });
  });

  // 10. Diagnostic enumeration (Requirement 12)
  describe('10. Diagnostics Enumeration (No Secrets)', () => {
    it('diagnoseTools enumerates public tools, availability, missing config, and permissions without exposing secrets', () => {
      const summary = diagnoseTools(
        catalog,
        config,
        { id: chat, isGroup: true, enabled: true },
        { id: owner, role: 'owner' },
      );

      expect(summary.publicToolsTotal).toBe(99);
      expect(summary.temporarilyGated).toBe(0);
      expect(summary.staticEligible).toBeGreaterThan(0);
      expect(summary.configured).toBeLessThan(summary.publicToolsTotal);
      expect(summary.currentlyExecutable).toBeNull();
      expect(summary.preconditionDependent).toContain('drive.upload');
      expect(summary.permissionConstrained.ownerOnly).toContain('control.emergency');
      expect(summary.permissionConstrained.ownerOnly).toContain('control.maintenance_on');
      expect(summary.permissionConstrained.ownerOnly).toContain('control.maintenance_off');

      // Verify no secrets or sensitive configuration values are exposed
      const json = JSON.stringify(summary);
      expect(json).not.toContain('fixture-gemini-key');
      expect(json).not.toContain(url);
      expect(json).not.toContain('password');
      expect(json).not.toContain('secret');
      expect(json).not.toContain('WEBHOOK_SECRET');
    });
  });
});
