import type { Db } from '../../src/db/client.js';
import { loadFixtureBuffer } from './evolution-payload.js';
import { digest } from '../../src/modules/media/storage.js';
import { QA_OWNER_JID, QA_MEMBER_JID } from '../../src/core/permissions.js';
import type {
  JobRecord,
  LlmUsageRecord,
  OutboxRecord,
  QaStatus,
  QaTurn,
  QaTurnResult,
  SessionRecord,
  ToolCallEvidence,
  ToolExecutionRecord,
} from './types.js';

export const DEFAULT_QA_CHAT_ID = process.env.QA_CHAT_ID ?? '120363431233265050@g.us';

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

/** Progress is advisory once the same job's terminal output was delivered. */
export function deliveryOutbox<T extends {kind:string;status:string;payload:Record<string,unknown>}>(rows: T[]): T[] {
  return rows.filter(row => row.kind !== 'media_progress' || !rows.some(terminal =>
    ['media_result','media_text','media_error'].includes(terminal.kind) && terminal.status === 'sent'
    && row.payload.jobId !== undefined && terminal.payload.jobId === row.payload.jobId));
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
 * Targeted QA-only state reset before running an independent test case.
 * Guaranteed never to touch real users or business state.
 */
export async function resetQaState(db: Db, chatId: string, actorId: string): Promise<void> {
  const isQaActor = actorId === QA_OWNER_JID || actorId === QA_MEMBER_JID;
  if (!isQaActor || chatId !== DEFAULT_QA_CHAT_ID) {
    return;
  }
  // Cancel active sessions_v2 for this QA actor in QA chat
  await db.query(
    `UPDATE sessions_v2 SET status = 'cancelled' WHERE chat_id = $1 AND actor_id = $2 AND status = 'active'`,
    [chatId, actorId]
  );
  // Clear video search sessions for this QA actor in QA chat
  await db.query(
    `DELETE FROM video_search_sessions WHERE chat_id = $1 AND actor_id = $2`,
    [chatId, actorId]
  );
  // Clear legacy sessions for this QA actor in QA chat
  await db.query(
    `DELETE FROM sessions WHERE chat_id = $1 AND owner_id = $2`,
    [chatId, actorId]
  );
}

/**
 * Polls the database and correlates inbox, turn, tool_executions, sessions_v2, jobs, and outbox.
 * Enforces terminal delivery checks before PASS.
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
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const startTime = Date.now();
  const turnStartTime = new Date(startTime - 2000);

  let turnId: string | undefined;
  let inboxStatus: string | undefined;
  const errors: string[] = [];

  let toolExecutions: ToolExecutionRecord[] = [];
  let toolCalls: ToolCallEvidence[] = [];
  let jobs: JobRecord[] = [];
  let outbox: OutboxRecord[] = [];
  let llmUsage: LlmUsageRecord[] = [];
  let finalText: string | null = null;
  let relevantSession: SessionRecord | null = null;

  let isTerminal = false;

  // Poll until inbox is complete and all downstream effects (jobs, outbox) reach terminal state
  while (Date.now() - startTime < timeoutMs) {
    if (!turnId || (inboxStatus !== 'done' && inboxStatus !== 'failed')) {
      const inboxRes = await db.query<{ id: string; turn_id: string; status: string; error: string | null }>(
        `SELECT id, turn_id, status, error FROM inbox WHERE payload->>'id' = $1 OR provider_msg_id = $1`,
        [providerMessageId]
      );
      const row = inboxRes.rows[0];
      if (row) {
        turnId = row.turn_id;
        inboxStatus = row.status;
        if (row.error) errors.push(`inbox_error: ${row.error}`);
      }
    }

    if (turnId) {
      const execRes = await db.query<{
        id: string;
        tool_name: string;
        status: string;
        risk_level: string;
        result_json: Record<string, unknown>;
        input_args: Record<string, unknown>;
        policy_decision: string | null;
        policy_code: string | null;
        created_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT id, tool_name, status, risk_level, result_json, input_args, policy_decision, policy_code, created_at, finished_at
         FROM tool_executions WHERE turn_id = $1 ORDER BY created_at ASC`,
        [turnId]
      );
      toolExecutions = execRes.rows.map(r => ({
        id: r.id,
        toolName: r.tool_name,
        status: r.status,
        riskLevel: r.risk_level,
        inputArgs: r.input_args ?? {},
        policyDecision: r.policy_decision,
        policyCode: r.policy_code,
        resultJson: r.result_json,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      }));

      toolCalls = execRes.rows.map(r => ({
        toolName: r.tool_name,
        inputArgs: r.input_args ?? {},
        policyStatus: r.policy_decision ?? (r.status === 'denied' ? 'denied' : 'allow'),
        policyCode: r.policy_code ?? null,
        executionStatus: r.status,
        result: r.result_json ?? {},
      }));
    }

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
    jobs = jobsRes.rows.map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      payload: j.payload,
      error: j.error,
      outboxId: j.outbox_id,
      result: j.result,
    }));

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
    outbox = outboxRes.rows.map(o => ({
      id: o.id,
      kind: o.kind,
      status: o.status,
      payload: o.payload,
      createdAt: o.created_at,
      sentAt: o.sent_at,
    }));
    for (const o of outbox) {
      const txt = o.payload.text;
      if (typeof txt === 'string' && txt.trim()) {
        finalText = txt.trim();
      }
    }

    if (inboxStatus === 'failed') {
      isTerminal = true;
      break;
    }

    if (inboxStatus === 'done') {
      const hasPendingJobs = jobs.some(j => j.status === 'queued' || j.status === 'running');
      const hasPendingOutbox = deliveryOutbox(outbox).some(o => o.status === 'queued' || o.status === 'sending');
      const hasJobTools = toolCalls.some(t =>
        ['media.process', 'media.collect', 'video.download', 'drive.upload', 'drive.download'].includes(t.toolName)
      );

      if (hasJobTools && jobs.length === 0 && Date.now() - startTime < Math.min(timeoutMs, 5000)) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      }

      if (!hasPendingJobs && !hasPendingOutbox) {
        if (outbox.length === 0 && Date.now() - startTime < Math.min(timeoutMs, 3000)) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          continue;
        }
        isTerminal = true;
        break;
      }
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Correlate relevant session strictly: only sessions created or transitioned in this turn
  if (turnId) {
    const sRes = await db.query<{
      id: string;
      kind: string;
      pending_tool: string;
      partial_args: Record<string, unknown>;
      missing_slots: unknown[];
      prompt: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT s.id, s.kind, s.pending_tool, s.partial_args, s.missing_slots, s.prompt, s.status, s.expires_at
       FROM sessions_v2 s
       WHERE (s.parent_execution_id IN (SELECT id FROM tool_executions WHERE turn_id = $1)
          OR s.confirmation_id IN (
            SELECT confirmation_id FROM tool_confirmations_v2 WHERE consumed_execution_id IN (SELECT id FROM tool_executions WHERE turn_id = $1)
          ))
       ORDER BY s.created_at DESC LIMIT 1`,
      [turnId]
    );
    if (sRes.rows[0]) {
      const s = sRes.rows[0];
      relevantSession = {
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
  }

  // Correlate video search session created by this turn
  const vsRes = await db.query<{
    id: string;
    query: string;
    source: string;
    results: unknown;
    expires_at: Date;
  }>(
    `SELECT id, query, source, results, expires_at
     FROM video_search_sessions
     WHERE chat_id = $1 AND actor_id = $2 AND created_at >= $3
     ORDER BY created_at DESC LIMIT 1`,
    [chatId, actorId, turnStartTime]
  );
  if (vsRes.rows[0]) {
    const vs = vsRes.rows[0];
    const results = Array.isArray(vs.results) ? (vs.results as { videoRef?: string; id?: string }[]) : [];
    const videoRefs = results.map(r => r.videoRef ?? r.id).filter((r): r is string => Boolean(r));
    if (!relevantSession) {
      relevantSession = {
        id: vs.id,
        kind: 'video_search',
        pendingTool: 'video.download',
        partialArgs: { query: vs.query, source: vs.source },
        missingSlots: [],
        prompt: `Video search: ${vs.query}`,
        status: 'active',
        expiresAt: vs.expires_at,
        videoRefs,
      };
    } else {
      relevantSession.videoRefs = videoRefs;
    }
  }

  // Fetch llm_usage
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
    llmUsage = llmRes.rows.map(l => ({
      id: l.id,
      model: l.model,
      purpose: l.purpose,
      status: l.status,
      inputTokens: l.input_tokens,
      outputTokens: l.output_tokens,
    }));
  }

  const latencyMs = Date.now() - startTime;

  let status: QaStatus = 'PASS';
  let terminalState = 'TERMINAL_DELIVERED';
  let failureClass: string | null = null;
  const isSuppressed = toolCalls.some(
    t => t.executionStatus === 'qa_suppressed' || (t.result as { code?: string })?.code === 'QA_SUPPRESSED'
  );

  const providerFail = classifyProviderFailure(finalText, errors);
  if (jobs.some(j => j.status === 'failed' || j.status === 'dead')) {
    status = 'FAIL';
    terminalState = 'JOB_FAILED';
    failureClass = 'JOB_FAILED';
    errors.push('One or more async jobs failed');
  } else if (providerFail) {
    status = providerFail;
    terminalState = providerFail;
    failureClass = providerFail;
  } else if (httpStatus >= 400 || inboxStatus === 'failed') {
    status = 'FAIL';
    terminalState = 'INBOX_FAILED';
    failureClass = 'INBOX_FAILED';
  } else if (!isTerminal) {
    status = 'FAIL';
    terminalState = 'TIMEOUT_INCOMPLETE';
    failureClass = 'TIMEOUT_DELIVERY';
    errors.push('Operation did not reach a terminal state within timeout');
  } else if (jobs.length > 0) {
    const allJobsDone = jobs.every(j => j.status === 'done');
    const allOutboxSent = deliveryOutbox(outbox).length > 0 && deliveryOutbox(outbox).every(o => o.status === 'sent');
    if (allJobsDone && allOutboxSent) {
      terminalState = isSuppressed ? 'QA_SUPPRESSED' : 'DELIVERED';
    } else if (!allJobsDone || !allOutboxSent) {
      status = 'FAIL';
      terminalState = 'JOB_INCOMPLETE';
      failureClass = 'TERMINAL_NOT_REACHED';
      errors.push('Jobs or outbox delivery not terminal');
    }
  } else if (outbox.length > 0) {
    const allSent = deliveryOutbox(outbox).every(o => o.status === 'sent');
    const anyFailed = deliveryOutbox(outbox).some(o => o.status === 'failed' || o.status === 'dead');
    if (allSent) {
      terminalState = isSuppressed ? 'QA_SUPPRESSED' : 'OUTBOX_SENT';
    } else if (anyFailed) {
      status = 'FAIL';
      terminalState = 'OUTBOX_FAILED';
      failureClass = 'OUTBOX_FAILED';
      errors.push('Outbox message delivery failed');
    } else {
      status = 'FAIL';
      terminalState = 'OUTBOX_INCOMPLETE';
      failureClass = 'TERMINAL_NOT_REACHED';
      errors.push('Outbox message not sent');
    }
  } else if (isSuppressed) {
    terminalState = 'QA_SUPPRESSED';
  }

  // Assertions against expected criteria
  if (expected) {
    if (expected.expectedTool !== undefined) {
      const executed = toolCalls.map(t => t.toolName);
      if (expected.expectedTool === null) {
        if (executed.length > 0) {
          errors.push(`Expected no tool execution, but got: ${executed.join(', ')}`);
          status = 'FAIL';
          failureClass = 'UNEXPECTED_TOOL_CALL';
        }
      } else {
        if (!executed.includes(expected.expectedTool)) {
          errors.push(`Expected tool "${expected.expectedTool}", but executed: ${executed.join(', ') || 'none'}`);
          status = 'FAIL';
          failureClass = 'TOOL_MISMATCH';
        }
      }
    }
    if (expected.expectedArgsPartial && toolCalls.length > 0) {
      const targetTool = toolCalls.find(t => t.toolName === expected.expectedTool) ?? toolCalls[0]!;
      for (const [k, v] of Object.entries(expected.expectedArgsPartial)) {
        const actualVal = targetTool.inputArgs[k];
        if (actualVal === undefined || actualVal !== v) {
          errors.push(`Expected inputArg [${k} = ${JSON.stringify(v)}], but got [${JSON.stringify(actualVal)}]`);
          status = 'FAIL';
          failureClass = 'ARG_MISMATCH';
        }
      }
    }
    if (expected.expectedPolicy && toolCalls.length > 0) {
      const targetTool = toolCalls.find(t => t.toolName === expected.expectedTool) ?? toolCalls[0]!;
      if (targetTool.policyStatus !== expected.expectedPolicy) {
        errors.push(`Expected policy "${expected.expectedPolicy}", but got "${targetTool.policyStatus}"`);
        status = 'FAIL';
        failureClass = 'POLICY_MISMATCH';
      }
    }
    if (expected.expectedStatus && toolCalls.length > 0) {
      const targetTool = toolCalls.find(t => t.toolName === expected.expectedTool) ?? toolCalls[0]!;
      if (targetTool.executionStatus !== expected.expectedStatus) {
        errors.push(`Expected status "${expected.expectedStatus}", but got "${targetTool.executionStatus}"`);
        status = 'FAIL';
        failureClass = 'STATUS_MISMATCH';
      }
    }
    if (expected.expectedReplySnippet && finalText) {
      if (!finalText.toLowerCase().includes(expected.expectedReplySnippet.toLowerCase())) {
        errors.push(`Expected reply to include "${expected.expectedReplySnippet}", got: "${finalText}"`);
        status = 'FAIL';
        failureClass = 'REPLY_MISMATCH';
      }
    }
  }

  if (errors.length > 0 && status === 'PASS') {
    status = 'FAIL';
    failureClass = failureClass ?? 'ASSERTION_FAILED';
  }

  const turnResult: QaTurnResult = {
    turnIndex,
    providerMessageId,
    turnId,
    input,
    httpStatus,
    httpResponse,
    inboxStatus,
    llmOutcome:
      toolCalls.length > 0
        ? `ToolCall: ${toolCalls.map(t => t.toolName).join(', ')}`
        : finalText
        ? 'DirectResponse'
        : 'NoResponse',
    toolCalls,
    toolExecutions,
    session: relevantSession,
    relevantSession,
    jobs,
    outbox,
    llmUsage,
    finalText,
    finalResponse: finalText,
    latencyMs,
    terminalState,
    status,
    failureClass,
    errors,
  };

  if (expected?.assertFn) {
    try {
      await expected.assertFn(turnResult);
    } catch (err: unknown) {
      turnResult.status = 'FAIL';
      turnResult.errors.push(err instanceof Error ? err.message : String(err));
      turnResult.failureClass = 'ASSERT_FN_FAILED';
    }
  }

  return turnResult;
}
