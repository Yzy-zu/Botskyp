import type { Db } from '../../src/db/client.js';
import { loadFixtureBuffer } from './evolution-payload.js';
import { digest } from '../../src/modules/media/storage.js';
import type {
  JobRecord,
  LlmUsageRecord,
  OutboxRecord,
  QaStatus,
  QaTurn,
  QaTurnResult,
  SessionRecord,
  ToolExecutionRecord,
} from './types.js';

export interface CollectorOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function classifyProviderFailure(text: string | null | undefined, errorList: string[]): QaStatus | null {
  const combined = `${text ?? ''} ${errorList.join(' ')}`.toLowerCase();
  if (
    combined.includes('límite de ia') ||
    combined.includes('rate_limit') ||
    combined.includes('429') ||
    combined.includes('quota') ||
    combined.includes('resource_exhausted')
  ) {
    return 'RATE_LIMIT';
  }
  if (
    combined.includes('la ia no pudo responder') ||
    combined.includes('503') ||
    combined.includes('504') ||
    combined.includes('unavailable') ||
    combined.includes('timeout') ||
    combined.includes('econnrefused') ||
    combined.includes('etimedout') ||
    combined.includes('fetch failed')
  ) {
    return 'INFRA_PROVIDER_FAILURE';
  }
  return null;
}

/**
 * Seeds a media fixture directly into media_attachments cache so the production worker
 * and artifact registration find it immediately without calling external Evolution API.
 */
export async function seedMediaFixture(
  db: Db,
  chatId: string,
  actorId: string,
  providerMessageId: string,
  fixturePath: string,
  artifactIndex = 0
): Promise<string> {
  const { buffer, mime } = loadFixtureBuffer(fixturePath);
  const sha = digest(buffer);
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO media_attachments (
        chat_id, owner_id, source_message_id, mime, size, sha256, is_original, data, artifact_index, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, clock_timestamp() + interval '2 days')
      ON CONFLICT DO NOTHING
      RETURNING id`,
      [chatId, actorId, providerMessageId, mime, buffer.length, sha, buffer, artifactIndex]
    )
  ).rows[0];

  return row?.id ?? 'existing';
}

/**
 * Polls the database and correlates inbox, turn, tool_executions, sessions_v2, jobs, and outbox.
 */
export async function collectTurnResult(
  db: Db,
  turnIndex: number,
  providerMessageId: string,
  chatId: string,
  actorId: string,
  input: string,
  httpStatus: number,
  httpResponse: unknown,
  expected?: QaTurn,
  options: CollectorOptions = {}
): Promise<QaTurnResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const startTime = Date.now();

  let turnId: string | undefined;
  let inboxStatus: string | undefined;
  const errors: string[] = [];

  // 1. Wait for inbox row to complete
  while (Date.now() - startTime < timeoutMs) {
    const inboxRes = await db.query<{ id: string; turn_id: string; status: string; error: string | null }>(
      `SELECT id, turn_id, status, error FROM inbox WHERE payload->>'id' = $1 OR provider_msg_id = $1`,
      [providerMessageId]
    );
    const row = inboxRes.rows[0];
    if (row) {
      turnId = row.turn_id;
      inboxStatus = row.status;
      if (row.error) errors.push(`inbox_error: ${row.error}`);
      if (row.status === 'done' || row.status === 'failed') {
        break;
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // 2. Fetch tool_executions for this turn
  const toolExecutions: ToolExecutionRecord[] = [];
  if (turnId) {
    const execRes = await db.query<{
      id: string;
      tool_name: string;
      status: string;
      risk_level: string;
      result_json: Record<string, unknown>;
      created_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, tool_name, status, risk_level, result_json, created_at, finished_at
       FROM tool_executions WHERE turn_id = $1 ORDER BY created_at ASC`,
      [turnId]
    );
    for (const r of execRes.rows) {
      toolExecutions.push({
        id: r.id,
        toolName: r.tool_name,
        status: r.status,
        riskLevel: r.risk_level,
        resultJson: r.result_json,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      });
    }
  }

  // 3. Fetch active or recent sessions_v2
  let session: SessionRecord | null = null;
  const sessionRes = await db.query<{
    id: string;
    kind: string;
    pending_tool: string;
    partial_args: Record<string, unknown>;
    missing_slots: unknown[];
    prompt: string;
    status: string;
    expires_at: Date;
  }>(
    `SELECT id, kind, pending_tool, partial_args, missing_slots, prompt, status, expires_at
     FROM sessions_v2 WHERE chat_id = $1 AND actor_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [chatId, actorId]
  );
  if (sessionRes.rows[0]) {
    const s = sessionRes.rows[0];
    session = {
      id: s.id,
      kind: s.kind,
      pendingTool: s.pending_tool,
      partialArgs: s.partial_args,
      missingSlots: s.missing_slots,
      prompt: s.prompt,
      status: s.status,
      expiresAt: s.expires_at,
    };
  }

  // 4. Fetch jobs associated with this turn/message
  const jobs: JobRecord[] = [];
  const jobsRes = await db.query<{
    id: string;
    kind: string;
    status: string;
    payload: Record<string, unknown>;
    error: string | null;
    outbox_id: string | null;
    result: Record<string, unknown> | null;
  }>(
    `SELECT id, kind, status, payload, error, outbox_id, result
     FROM jobs WHERE source_message_id = $1 ORDER BY id ASC`,
    [providerMessageId]
  );
  for (const j of jobsRes.rows) {
    jobs.push({
      id: j.id,
      kind: j.kind,
      status: j.status,
      payload: j.payload,
      error: j.error,
      outboxId: j.outbox_id,
      result: j.result,
    });
    if (j.error) errors.push(`job_${j.kind}_error: ${j.error}`);
  }

  // 5. Fetch outbox reply
  const outbox: OutboxRecord[] = [];
  let finalText: string | null = null;
  const outboxRes = await db.query<{
    id: string;
    kind: string;
    status: string;
    payload: Record<string, unknown>;
    created_at: Date;
    sent_at: Date | null;
  }>(
    `SELECT id, kind, status, payload, created_at, sent_at
     FROM outbox
     WHERE payload->>'sourceId' = $1 OR dedupe_key LIKE '%' || $1 || '%'
     ORDER BY id ASC`,
    [providerMessageId]
  );
  for (const o of outboxRes.rows) {
    outbox.push({
      id: o.id,
      kind: o.kind,
      status: o.status,
      payload: o.payload,
      createdAt: o.created_at,
      sentAt: o.sent_at,
    });
    const txt = o.payload.text;
    if (typeof txt === 'string' && txt.trim()) {
      finalText = txt.trim();
    }
  }

  // 6. Fetch llm_usage
  const llmUsage: LlmUsageRecord[] = [];
  if (turnId) {
    const llmRes = await db.query<{
      id: string;
      model: string;
      purpose: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT id, model, purpose, status, input_tokens, output_tokens
       FROM llm_usage WHERE turn_id = $1`,
      [turnId]
    );
    for (const l of llmRes.rows) {
      llmUsage.push({
        id: l.id,
        model: l.model,
        purpose: l.purpose,
        status: l.status,
        inputTokens: l.input_tokens,
        outputTokens: l.output_tokens,
      });
    }
  }

  const latencyMs = Date.now() - startTime;

  // 7. Status classification
  let status: QaStatus = 'PASS';
  const providerFail = classifyProviderFailure(finalText, errors);
  if (providerFail) {
    status = providerFail;
  } else if (httpStatus >= 400 || inboxStatus === 'failed') {
    status = 'FAIL';
  } else if (expected) {
    if (expected.expectedTool !== undefined) {
      const executed = toolExecutions.map(t => t.toolName);
      if (expected.expectedTool === null) {
        if (executed.length > 0) {
          errors.push(`Expected no tool execution, but got: ${executed.join(', ')}`);
          status = 'FAIL';
        }
      } else {
        if (!executed.includes(expected.expectedTool)) {
          errors.push(`Expected tool "${expected.expectedTool}", but executed: ${executed.join(', ') || 'none'}`);
          status = 'FAIL';
        }
      }
    }
    if (expected.expectedStatus && toolExecutions.length > 0) {
      const match = toolExecutions.some(t => t.status === expected.expectedStatus);
      if (!match) {
        errors.push(`Expected status "${expected.expectedStatus}", but got: ${toolExecutions.map(t => t.status).join(', ')}`);
        status = 'FAIL';
      }
    }
    if (expected.expectedReplySnippet && finalText) {
      if (!finalText.toLowerCase().includes(expected.expectedReplySnippet.toLowerCase())) {
        errors.push(`Expected reply to include "${expected.expectedReplySnippet}", got: "${finalText}"`);
        status = 'FAIL';
      }
    }
  }

  const turnResult: QaTurnResult = {
    turnIndex,
    providerMessageId,
    turnId,
    input,
    httpStatus,
    httpResponse,
    inboxStatus,
    toolExecutions,
    session,
    jobs,
    outbox,
    llmUsage,
    finalText,
    latencyMs,
    status,
    errors,
  };

  if (expected?.assertFn) {
    try {
      await expected.assertFn(turnResult);
    } catch (err: unknown) {
      turnResult.status = 'FAIL';
      turnResult.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return turnResult;
}
