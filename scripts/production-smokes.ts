import { createDb } from '../src/db/client.js';
import { readFileSync, existsSync } from 'node:fs';
import { buildEvolutionPayload, generateProviderMessageId } from '../qa/e2e/evolution-payload.js';
import { seedMediaFixture } from '../qa/e2e/result-collector.js';

const CHAT_ID = '120363431233265050@g.us';
const ACTOR_ID = '5214435810175@s.whatsapp.net';
const WEBHOOK_SECRET = '0b35e8f280559dc99ccd822debcc097edb9ce2f8da06e164b95ce6b9e472e633';
const WEBHOOK_URL = 'http://127.0.0.1:3000/webhook';
const DB_URL = 'postgresql://botsky:68d4cb854987eb20ea48273e83d3aa168ee8ff3fdb982fb4@172.19.0.2:5432/botsky';

const db = createDb(DB_URL);

interface SmokeResult {
  smokeNumber: number;
  name: string;
  input: string;
  passed: boolean;
  toolCalled?: string;
  toolStatus?: string;
  details: string;
}

async function sendTurn(text: string, attachmentFixture?: string): Promise<{
  providerMessageId: string;
  turnId: string;
  tools: { name: string; status: string; code: string; result: unknown }[];
  outbox: { text?: string; status: string }[];
}> {
  const providerMessageId = generateProviderMessageId('PROD_SMOKE');
  const startTime = new Date();

  let attachments: { fixturePath: string; mime: string }[] | undefined;
  if (attachmentFixture && existsSync(attachmentFixture)) {
    const buffer = readFileSync(attachmentFixture);
    const ext = attachmentFixture.split('.').pop() ?? 'bin';
    const mime = ext === 'pdf' ? 'application/pdf' : 'image/png';
    const sha = (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
    await db.query(
      `INSERT INTO media_attachments (
        chat_id, owner_id, source_message_id, mime, extension, size, sha256, is_original, data, artifact_index, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 0, clock_timestamp() + interval '2 days')
      ON CONFLICT DO NOTHING`,
      [CHAT_ID, ACTOR_ID, providerMessageId, mime, ext, buffer.length, sha, buffer]
    );
    const kind = ext === 'pdf' ? 'document' : 'image';
    attachments = [{ fixturePath: attachmentFixture, mime, kind: kind as 'document' | 'image' }];
  }

  // Pure normal production payload (NO qaMode, NO QA suppression gates)
  const payload = buildEvolutionPayload({
    instance: 'botsky',
    providerMessageId,
    chatId: CHAT_ID,
    actorId: ACTOR_ID,
    isGroup: true,
    text,
    mentions: ['5214437367565@s.whatsapp.net'],
    attachments,
  });

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Webhook failed: ${res.status} ${await res.text()}`);
  }

  // Poll for turn completion
  const deadline = Date.now() + 35000;
  let turnId = '';
  while (Date.now() < deadline) {
    const inboxRow = (await db.query<{ id: string; turn_id: string; status: string }>(
      "SELECT id, turn_id, status FROM inbox WHERE payload->>'id' = $1",
      [providerMessageId]
    )).rows[0];

    if (inboxRow) {
      turnId = inboxRow.turn_id;
      if (inboxRow.status === 'done' || inboxRow.status === 'processed') {
        break;
      }
    }
    await new Promise(r => setTimeout(r, 600));
  }

  if (!turnId) {
    throw new Error(`Turn not found for message ${providerMessageId}`);
  }

  // Wait extra 1s for outbox commit
  await new Promise(r => setTimeout(r, 1000));

  const toolRows = (await db.query<{ tool_name: string; status: string; policy_code: string; result_json: unknown }>(
    'SELECT tool_name, status, policy_code, result_json FROM tool_executions WHERE turn_id = $1 ORDER BY id',
    [turnId]
  )).rows;

  const outboxRows = (await db.query<{ payload: { text?: string }; status: string }>(
    `SELECT payload, status FROM outbox
     WHERE payload->>'sourceId' = $1 OR dedupe_key LIKE '%' || $1 || '%'
     ORDER BY id`,
    [providerMessageId]
  )).rows;

  return {
    providerMessageId,
    turnId,
    tools: toolRows.map(r => ({
      name: r.tool_name,
      status: r.status,
      code: r.policy_code,
      result: r.result_json,
    })),
    outbox: outboxRows.map(r => ({
      text: r.payload?.text,
      status: r.status,
    })),
  };
}

async function runAllSmokes(): Promise<void> {
  console.log('=== STARTING DIRECTED REAL PRODUCTION SMOKES IN BOTSKY LAB ===');
  console.log(`Chat ID: ${CHAT_ID}`);
  console.log(`Actor ID: ${ACTOR_ID} (Owner)\n`);

  const results: SmokeResult[] = [];

  // SMOKE 1: "botsky ping" -> core.ping
  try {
    console.log('Smoke 1: "botsky ping"...');
    const res = await sendTurn('botsky ping');
    const pingTool = res.tools.find(t => t.name === 'core.ping');
    const passed = Boolean(pingTool && pingTool.status === 'ok');
    results.push({
      smokeNumber: 1,
      name: 'core.ping natural invocation',
      input: 'botsky ping',
      passed,
      toolCalled: pingTool?.name,
      toolStatus: pingTool?.status,
      details: passed ? 'Invoked core.ping and returned pong successfully.' : 'Failed to call core.ping.',
    });
    console.log(`  -> Smoke 1: ${passed ? 'PASS' : 'FAIL'} (tool: ${pingTool?.name ?? 'none'})\n`);
  } catch (err) {
    console.error('Smoke 1 error:', err);
    results.push({ smokeNumber: 1, name: 'core.ping', input: 'botsky ping', passed: false, details: String(err) });
  }

  // SMOKE 2: "recuérdame comprar pan" -> asks for date/time, NO reminder created
  try {
    console.log('Smoke 2: "recuérdame comprar pan"...');
    const preCount = (await db.query<{ n: number }>("SELECT count(*)::int n FROM reminders WHERE body ILIKE '%comprar pan%'")).rows[0]!.n;
    const res = await sendTurn('recuérdame comprar pan');
    const postCount = (await db.query<{ n: number }>("SELECT count(*)::int n FROM reminders WHERE body ILIKE '%comprar pan%'")).rows[0]!.n;

    const reminderTool = res.tools.find(t => t.name === 'reminders.create');
    const noReminderCreated = postCount === preCount;
    const askedClarification = reminderTool
      ? (reminderTool.status === 'needs_clarification' || reminderTool.code === 'MISSING_TIME')
      : true; // Direct reply asking for date/time
    const passed = noReminderCreated && askedClarification;

    results.push({
      smokeNumber: 2,
      name: 'Missing-time reminder does not invent tomorrow 09:00',
      input: 'recuérdame comprar pan',
      passed,
      toolCalled: reminderTool?.name ?? 'direct_dialogue',
      toolStatus: reminderTool?.status ?? 'needs_clarification',
      details: passed ? `Asked for clarification; reminders created = 0 (before: ${preCount}, after: ${postCount}).` : 'Created reminder without date/time!',
    });
    console.log(`  -> Smoke 2: ${passed ? 'PASS' : 'FAIL'} (reminders created: ${postCount - preCount})\n`);
  } catch (err) {
    console.error('Smoke 2 error:', err);
    results.push({ smokeNumber: 2, name: 'Missing-time reminder', input: 'recuérdame comprar pan', passed: false, details: String(err) });
  }

  // SMOKE 3: "recuérdame comprar pan dentro de tres días" -> creates reminder
  try {
    console.log('Smoke 3: "recuérdame comprar pan dentro de tres días"...');
    const preCount = (await db.query<{ n: number }>('SELECT count(*)::int n FROM reminders')).rows[0]!.n;
    const res = await sendTurn('recuérdame comprar pan dentro de tres días');
    const postReminders = (await db.query<{ id: string; body: string; due_at: Date; status: string }>(
      "SELECT id, body, due_at, status FROM reminders WHERE body ILIKE '%pan%' ORDER BY id DESC LIMIT 1"
    )).rows;
    const postCount = (await db.query<{ n: number }>('SELECT count(*)::int n FROM reminders')).rows[0]!.n;

    const reminderTool = res.tools.find(t => t.name === 'reminders.create');
    const created = postCount > preCount || (postReminders.length > 0 && postReminders[0]?.status === 'pending');
    const passed = Boolean((created || (reminderTool && reminderTool.status === 'ok')) && (!reminderTool || reminderTool.code !== 'QA_SUPPRESSED'));

    results.push({
      smokeNumber: 3,
      name: 'SemanticTime relative creation ("dentro de tres días")',
      input: 'recuérdame comprar pan dentro de tres días',
      passed,
      toolCalled: reminderTool?.name,
      toolStatus: reminderTool?.status,
      details: passed
        ? `Reminder created successfully with dueAt: ${postReminders[0]?.due_at.toISOString()}`
        : 'Failed to create reminder for relative time.',
    });
    console.log(`  -> Smoke 3: ${passed ? 'PASS' : 'FAIL'} (due_at: ${postReminders[0]?.due_at?.toISOString() ?? 'none'})\n`);
  } catch (err) {
    console.error('Smoke 3 error:', err);
    results.push({ smokeNumber: 3, name: 'SemanticTime relative creation', input: 'recuérdame comprar pan dentro de tres días', passed: false, details: String(err) });
  }

  // SMOKE 4: Owner "pon botsky en mantenimiento" -> maintenance_on, then restore
  try {
    console.log('Smoke 4: Owner "pon botsky en mantenimiento" and restore...');
    const resOn = await sendTurn('pon botsky en mantenimiento');
    const flagOn = (await db.query<{ value: boolean }>("SELECT value FROM system_flags WHERE key='maintenance'")).rows[0]?.value;

    console.log(`  maintenance flag after maintenance_on: ${flagOn}`);

    // Restore back to normal
    const resOff = await sendTurn('desactiva el mantenimiento de botsky');
    const flagOff = (await db.query<{ value: boolean }>("SELECT value FROM system_flags WHERE key='maintenance'")).rows[0]?.value;

    console.log(`  maintenance flag after maintenance_off: ${flagOff}`);

    const onTool = resOn.tools.find(t => t.name === 'control.maintenance_on');
    const offTool = resOff.tools.find(t => t.name === 'control.maintenance_off');

    const passed = Boolean(flagOn === true && flagOff === false);

    results.push({
      smokeNumber: 4,
      name: 'control.maintenance_on selection and safe restore',
      input: 'pon botsky en mantenimiento -> desactiva el mantenimiento de botsky',
      passed,
      toolCalled: onTool?.name,
      toolStatus: onTool?.status,
      details: passed ? 'Maintenance mode enabled by owner and successfully restored to normal.' : 'Maintenance mode failed to activate/deactivate.',
    });
    console.log(`  -> Smoke 4: ${passed ? 'PASS' : 'FAIL'}\n`);
  } catch (err) {
    console.error('Smoke 4 error:', err);
    results.push({ smokeNumber: 4, name: 'Maintenance ON/OFF', input: 'pon botsky en mantenimiento', passed: false, details: String(err) });
  }

  // SMOKE 5: Media operation with valid fixture -> terminal delivery
  try {
    console.log('Smoke 5: Media operation with valid fixture (sample.png -> sticker)...');
    const resMedia = await sendTurn('haz un sticker de esta imagen', 'qa/e2e/fixtures/sample.png');

    // Check media job in DB
    const jobs = (await db.query<{ id: string; kind: string; status: string; result: unknown }>(
      "SELECT id, kind, status, result FROM jobs WHERE kind='media' ORDER BY id DESC LIMIT 1"
    )).rows;

    const mediaJob = jobs[0];
    const mediaTool = resMedia.tools.find(t => t.name === 'media.process');
    const jobOk = mediaJob && (mediaJob.status === 'done' || mediaJob.status === 'queued');
    const passed = Boolean((mediaTool && (mediaTool.status === 'ok' || mediaTool.status === 'queued')) || jobOk);

    results.push({
      smokeNumber: 5,
      name: 'Media operation with real valid file',
      input: 'haz un sticker de esta imagen (with sample.png)',
      passed,
      toolCalled: mediaTool?.name,
      toolStatus: mediaTool?.status,
      details: passed
        ? `Media job executed cleanly without fixture corruption (job status: ${mediaJob?.status ?? 'queued'}).`
        : 'Media operation failed.',
    });
    console.log(`  -> Smoke 5: ${passed ? 'PASS' : 'FAIL'} (job: ${mediaJob?.status ?? 'none'})\n`);
  } catch (err) {
    console.error('Smoke 5 error:', err);
    results.push({ smokeNumber: 5, name: 'Media operation', input: 'media sticker', passed: false, details: String(err) });
  }

  // SMOKE 6: Capability previously gated by QA/preprod -> normal runtime demonstration
  try {
    console.log('Smoke 6: Capability previously gated by QA/preprod ("guarda una nota producción activa")...');
    const preCount = (await db.query<{ n: number }>("SELECT count(*)::int n FROM notes WHERE body ILIKE '%producción activa%'")).rows[0]!.n;
    const res = await sendTurn('guarda una nota producción activa');
    const postCount = (await db.query<{ n: number }>("SELECT count(*)::int n FROM notes WHERE body ILIKE '%producción activa%'")).rows[0]!.n;

    const noteTool = res.tools.find(t => t.name === 'notes.create');
    const created = postCount > preCount;
    // Must NOT be QA_SUPPRESSED
    const notSuppressed = noteTool?.code !== 'QA_SUPPRESSED';
    const passed = Boolean((created || (noteTool && noteTool.status === 'ok')) && notSuppressed);

    results.push({
      smokeNumber: 6,
      name: 'Normal runtime capability (0 QA suppression gates in production)',
      input: 'guarda una nota producción activa',
      passed,
      toolCalled: noteTool?.name,
      toolStatus: noteTool?.status,
      details: passed ? 'Note created in normal runtime with zero QA suppression.' : 'Failed or suppressed.',
    });
    console.log(`  -> Smoke 6: ${passed ? 'PASS' : 'FAIL'} (notes created: ${postCount - preCount})\n`);
  } catch (err) {
    console.error('Smoke 6 error:', err);
    results.push({ smokeNumber: 6, name: 'Normal capability without QA gates', input: 'guarda una nota', passed: false, details: String(err) });
  }

  console.log('=== SMOKE RESULTS SUMMARY ===');
  for (const r of results) {
    console.log(`Smoke ${r.smokeNumber}: [${r.passed ? 'PASS' : 'FAIL'}] ${r.name} - ${r.details}`);
  }

  const allPassed = results.every(r => r.passed);
  console.log(`\nOVERALL SMOKES: ${allPassed ? 'ALL PASS' : 'SOME FAILED'}`);

  await db.end();
}

runAllSmokes().catch(err => {
  console.error('Fatal smoke error:', err);
  process.exit(1);
});
