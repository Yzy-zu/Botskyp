export type QaMode = 'SAFE' | 'LIVE_SAFE';

export type QaStatus =
  | 'PASS'
  | 'FAIL'
  | 'INFRA_PROVIDER_FAILURE'
  | 'RATE_LIMIT'
  | 'BLOCKED'
  | 'SKIPPED';

export type EvolutionMessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker';

export interface EvolutionAttachmentOption {
  kind: EvolutionMessageType;
  fixturePath?: string | undefined;
  mimetype?: string | undefined;
  fileName?: string | undefined;
  caption?: string | undefined;
  base64?: string | undefined;
}

export interface EvolutionPayloadOptions {
  instance?: string | undefined;
  providerMessageId?: string | undefined;
  chatId: string;
  actorId: string;
  isGroup?: boolean | undefined;
  text?: string | undefined;
  attachments?: EvolutionAttachmentOption[] | undefined;
  quoted?: {
    stanzaId: string;
    participant?: string | undefined;
    text?: string | undefined;
    image?: boolean | undefined;
  } | undefined;
  mentions?: string[] | undefined;
  timestamp?: number | undefined;
}

export interface QaTurn {
  id?: string | undefined;
  input: string;
  attachment?: EvolutionAttachmentOption | undefined;
  attachments?: EvolutionAttachmentOption[] | undefined;
  quotePrevious?: boolean | undefined;
  expectedTool?: string | null | undefined;
  expectedArgsPartial?: Record<string, unknown> | undefined;
  expectedStatus?: 'ok' | 'needs_confirmation' | 'needs_clarification' | 'queued' | 'denied' | undefined;
  expectedReplySnippet?: string | undefined;
  assertFn?: ((result: QaTurnResult) => Promise<void> | void) | undefined;
}

export interface QaCase {
  id: string;
  title: string;
  description?: string | undefined;
  suite: string;
  mode: QaMode;
  chatId?: string | undefined;
  actorId?: string | undefined;
  isGroup?: boolean | undefined;
  turns: QaTurn[];
}

export interface ToolExecutionRecord {
  id: string;
  toolName: string;
  status: string;
  riskLevel: string;
  resultJson: Record<string, unknown>;
  createdAt: Date;
  finishedAt?: Date | null | undefined;
}

export interface SessionRecord {
  id: string;
  kind: string;
  pendingTool: string;
  partialArgs: Record<string, unknown>;
  missingSlots: unknown[];
  prompt: string;
  status: string;
  expiresAt: Date;
}

export interface JobRecord {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  error?: string | null | undefined;
  outboxId?: string | null | undefined;
  result?: Record<string, unknown> | null | undefined;
}

export interface OutboxRecord {
  id: string;
  kind: string;
  status: string;
  payload: {
    text?: string | undefined;
    sourceId?: string | undefined;
    jobId?: string | undefined;
    actorId?: string | undefined;
    attachmentId?: string | undefined;
    mediaKind?: string | undefined;
    fileName?: string | undefined;
    [key: string]: unknown;
  };
  createdAt: Date;
  sentAt?: Date | null | undefined;
}

export interface LlmUsageRecord {
  id: string;
  model: string;
  purpose: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
}

export interface QaTurnResult {
  turnIndex: number;
  providerMessageId: string;
  turnId?: string | undefined;
  input: string;
  httpStatus: number;
  httpResponse: unknown;
  inboxStatus?: string | undefined;
  toolExecutions: ToolExecutionRecord[];
  session: SessionRecord | null;
  jobs: JobRecord[];
  outbox: OutboxRecord[];
  llmUsage: LlmUsageRecord[];
  finalText: string | null;
  latencyMs: number;
  status: QaStatus;
  errors: string[];
}

export interface QaCaseResult {
  caseId: string;
  title: string;
  suite: string;
  mode: QaMode;
  status: QaStatus;
  providerMessageIds: string[];
  turnIds: string[];
  inputs: string[];
  actualTools: string[];
  args: Record<string, unknown>[];
  policy: Record<string, unknown>[];
  session: SessionRecord | null;
  jobs: JobRecord[];
  outbox: OutboxRecord[];
  finalText: string | null;
  latency: number;
  errors: string[];
  turnResults: QaTurnResult[];
  recordedAt: string;
}

export interface RunnerOptions {
  caseId?: string | undefined;
  suite?: string | undefined;
  mode?: QaMode | undefined;
  targetUrl?: string | undefined;
  webhookSecret?: string | undefined;
  qaChatId?: string | undefined;
  qaActorId?: string | undefined;
  resume?: boolean | undefined;
  dryRun?: boolean | undefined;
  outputDir?: string | undefined;
  timeoutMs?: number | undefined;
}
