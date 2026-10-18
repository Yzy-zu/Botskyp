import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { createDb, transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { route } from '../src/core/router.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { calculateRouterShadow, observeRouterShadow } from '../src/core/router-shadow.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Llm } from '../src/core/llm.js';
import { reserveCall } from '../src/core/quota.js';

const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Unsafe test database');
const db = createDb(url);
const config = readConfig({ROUTER_MODE:'v1',GEMINI_API_KEY:'fixture-gemini-key', DATABASE_URL: url, EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: '100@s.whatsapp.net', BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: '300@g.us', TRANSPORT: 'mock' });
const catalog = createToolRegistryV2(createRegistry());
beforeAll(() => migrate(db));
afterAll(() => db.end());
beforeEach(async () => {
  await db.query('TRUNCATE message_turns,chats,users,system_flags,sessions,notes,context_msgs,llm_usage,llm_cooldowns,audit_log CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
  await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net')");
});
function withContext<T>(mode: 'v1' | 'v1_1_shadow' | 'v1_1', text: string, fn: (ctx: ToolCtx) => Promise<T>): Promise<T> {
  return transaction(db, c => fn({
    c, db, config: { ...config, ROUTER_MODE: mode }, now: new Date('2026-10-17T12:00:00Z'),
    actor: { id: '100@s.whatsapp.net', role: 'owner' },
    chat: { id: '300@g.us', isGroup: true, enabled: true, settings: {} },
    msg: { id: randomUUID(), senderId: '100@s.whatsapp.net', chatId: '300@g.us', isGroup: true, ts: new Date(), text, fromMe: false, mentions: [], attachments: [] },
    search: async () => 'mock search',
  }));
}
it('calculates sanitized shadow decisions without leaking raw text, quotes, attachments or actor identities', () => {
  const summary = calculateRouterShadow(catalog, {
    text: 'reinicia minecraft 123@s.whatsapp.net secret-token', quotedText: 'private phrase',
    actorRole: 'member', chatType: 'group', enabledModules: ['core','minecraft'], currentArtifact: { kind: 'pdf' },
  });
  expect(summary.fastPathMatch).toBe(false);
  expect(summary.domains).toContain('minecraft');
  expect(summary.tools).toContain('minecraft.restart');
  expect(summary.approximateSchemaBytes).toBeGreaterThan(0);
  expect(JSON.stringify(summary)).not.toMatch(/123@|secret-token|private phrase/);
});
it('does no queries, business writes, provider calls or v2 execution when observing shadow', async () => {
  await withContext('v1_1_shadow', 'botsky guarda en tu memoria que me gustan los tacos', async ctx => {
    const query = vi.spyOn(ctx.c, 'query');
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      observeRouterShadow(ctx, undefined, () => catalog);
      expect(query).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { query.mockRestore(); network.mockRestore(); }
  });
  for (const table of ['notes','user_memories','reminders','tool_executions','llm_usage']) expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(0);
});
it('never calculates v2 in v1 or reserved v1_1 and isolates shadow calculation failures', async () => {
  for (const mode of ['v1','v1_1'] as const) await withContext(mode, 'bot ping', async ctx => {
    const getter = vi.fn(() => { throw new Error('unexpected'); });
    observeRouterShadow(ctx, undefined, getter); expect(getter).not.toHaveBeenCalled();
  });
  await withContext('v1_1_shadow', 'bot ping', async ctx => {
    expect(() => observeRouterShadow(ctx, undefined, () => { throw new Error('sensitive failure'); })).not.toThrow();
  });
});
it('keeps the v1 response, query sequence, and single Gemini call unchanged in shadow', async () => {
  const results: { reply: string | undefined; queries: unknown[]; calls: unknown[] }[] = [];
  for (const mode of ['v1','v1_1_shadow'] as const) await withContext(mode, 'hola botsky', async ctx => {
    const generate = vi.fn<Llm['generate']>(async () => ({ text: 'Hola.', calls: [], content: {} }));
    const query = vi.spyOn(ctx.c, 'query');
    try {
      const reply = await route(ctx, { generate });
      expect(generate).toHaveBeenCalledOnce();
      results.push({ reply, queries: query.mock.calls, calls: generate.mock.calls });
    } finally { query.mockRestore(); }
  });
  expect(results[1]).toEqual(results[0]);
  expect(results[0]?.reply).toBe('Hola.');
});
it('retains visible legacy shortcuts in shadow while v2 only observes the memory ambiguity', async () => {
  for (const mode of ['v1','v1_1_shadow'] as const) {
    const text = 'botsky guarda en tu memoria que me gustan los tacos';
    await withContext(mode, text, async ctx => {
      const generate = vi.fn<Llm['generate']>();
      expect(await route(ctx, { generate })).toContain('Guardé la nota #');
      expect(generate).not.toHaveBeenCalled();
    });
  }
  expect((await db.query('SELECT count(*)::int AS n FROM notes')).rows[0]?.n).toBe(2);
  expect((await db.query('SELECT count(*)::int AS n FROM user_memories')).rows[0]?.n).toBe(0);
  expect((await db.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0]?.n).toBe(0);
});
it('uses a configured fallback token reservation without overriding explicit v1 estimates', async () => {
  const configured = readConfig({ROUTER_MODE:'v1',GEMINI_API_KEY:'fixture-gemini-key', DATABASE_URL: url, EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: '100@s.whatsapp.net', BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: '300@g.us', TRANSPORT: 'mock', LLM_RESERVED_INPUT_TOKENS: '1000' });
  const limits = { userRpm: 8, globalRpm: 5, dailyLimit: 20, inputTokensPerMinute: 65536, reservedInputTokens: configured.LLM_RESERVED_INPUT_TOKENS };
  await reserveCall(db, 'actor', 'mock', 'test', undefined, limits);
  await reserveCall(db, 'actor', 'mock', 'test', 600, limits);
  expect((await db.query('SELECT reserved_input_tokens FROM llm_usage ORDER BY at')).rows).toEqual([{ reserved_input_tokens: 1000 }, { reserved_input_tokens: 600 }]);
});
