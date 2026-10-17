import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/client.js';
import { readConfig } from '../src/config.js';
import { executeToolV2 } from '../src/core/policy-v2/executor.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import type { Msg } from '../src/wa/types.js';
const { url } = JSON.parse(readFileSync('.local/test-db.json', 'utf8')) as { url: string };
const target = new URL(url);
if (!target.pathname.startsWith('/botsky_test_')) throw new Error('Unsafe crash test database');
target.searchParams.set('application_name', 'r3-policy-crash');
const db = createDb(target.toString());
const config = readConfig({GEMINI_API_KEY:'fixture-gemini-key', DATABASE_URL: target.toString(), EVOLUTION_URL: 'http://mock', EVOLUTION_APIKEY: 'test', INSTANCE: 'test', WEBHOOK_SECRET: 'x'.repeat(32), OWNER_JIDS: '100@s.whatsapp.net', BOT_JIDS: '200@s.whatsapp.net', LAB_CHAT_ID: '300@g.us', TRANSPORT: 'mock', ROUTER_MODE: 'v1_1' });
const turnId = process.argv[2], mode = process.argv[3];
const c = await db.connect();
try {
  const msg = (await c.query<{ payload: Msg }>('SELECT payload FROM inbox WHERE turn_id=$1', [turnId])).rows[0]!.payload;
  await executeToolV2({ c, db, config, ...(turnId ? { turnId } : {}), msg, actor: { id: msg.senderId, role: 'member' },
    chat: { id: msg.chatId, isGroup: true, enabled: true, settings: {} }, now: new Date(), search: async () => '' },
  'notes.create', { body: 'crash-fixture' }, { callOrigin: 'fast_path', safeRefMap: new SafeRefs([]) });
  // Deliberate death after commit, before a response can be emitted to a caller.
  if (mode === 'postcommit') process.kill(process.pid, 'SIGKILL');
} finally { c.release(); await db.end(); }
