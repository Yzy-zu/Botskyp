import type { GeminiFunctionCall, ProviderToolContext } from '../provider-tool-context.js';
import type { Image, Declaration, LlmInput, LlmReply, Llm } from '../llm.js';

export type ProviderId = 'gemini' | 'groq' | 'openrouter';

export type FailureKind =
  | 'quota'
  | 'provider'
  | 'timeout'
  | 'invalid'
  | 'blocked'
  | 'auth'
  | 'incompatible';

export type NormalizedToolCall = {
  id?: string | undefined;
  name: string;
  args?: unknown;
};

export type NormalizedAssistantTurn = {
  provider: ProviderId | string;
  model: string;
  text?: string | undefined;
  toolCalls?: NormalizedToolCall[] | undefined;
  providerState?: unknown;
};

export type NormalizedToolResult = {
  toolCallId?: string | undefined;
  name: string;
  result: Record<string, unknown>;
};

export type NormalizedTurn =
  | { role: 'user'; text: string; images?: Image[] | undefined }
  | { role: 'assistant'; turn: NormalizedAssistantTurn }
  | { role: 'tool_results'; results: NormalizedToolResult[]; images?: Image[] | undefined };

export type NormalizedTurnHistory = {
  system: string;
  userText: string;
  initialImages: Image[];
  steps: Array<{
    assistant: NormalizedAssistantTurn;
    toolResults: NormalizedToolResult[];
    loadedImages?: Image[] | undefined;
  }>;
};

export type ModelCapability = {
  provider: ProviderId;
  model: string;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsJsonSchema: boolean;
  supportsVision: boolean;
  contextWindow: number;
  knownInputTokenLimit?: number | undefined;
  knownRateLimitWhenAvailable?: {
    tpm?: number | undefined;
    rpm?: number | undefined;
  } | undefined;
  fullCatalogCompatible: boolean;
  chatCompatible: boolean;
  agentCompatible: boolean;
  enabled: boolean;
};

export type RouteCandidate = {
  provider: ProviderId;
  model: string;
  priority: number;
  enabled: boolean;
};

export type RateLimitTelemetry = {
  provider: ProviderId;
  credentialId: string;
  model: string;
  httpStatus?: number | undefined;
  retryAfterMs?: number | undefined;
  limit?: number | undefined;
  remaining?: number | undefined;
  resetMs?: number | undefined;
  providerErrorCode?: string | undefined;
  latencyMs: number;
};

export type FallbackAttemptRecord = {
  ordinal: number;
  provider: ProviderId;
  credentialId: string;
  model: string;
  result: 'success' | 'quota' | 'provider' | 'timeout' | 'auth' | 'blocked' | 'invalid' | 'preflight_skipped';
  httpStatus?: number | undefined;
  skipReason?: string | undefined;
  latencyMs?: number | undefined;
};

export type TurnFallbackLog = {
  turnId?: string | undefined;
  attempts: FallbackAttemptRecord[];
  finalProvider?: ProviderId | undefined;
  finalModel?: string | undefined;
  success: boolean;
};

export type OperationalHealth = 'healthy' | 'cooldown' | 'disabled' | 'incompatible';

export type CandidateHealthState = {
  provider: ProviderId;
  credentialId: string;
  model: string;
  status: OperationalHealth;
  lastSuccessAt: number;
  lastFailureAt: number;
  consecutive429: number;
  consecutiveErrors: number;
  cooldownUntil: number;
  lastLatencyMs: number;
};

export type PreflightDecision =
  | { ok: true; estimatedTokens: number }
  | { ok: false; reason: 'MODEL_REQUEST_TOO_LARGE' | 'MODEL_RATE_BUDGET_INCOMPATIBLE'; estimatedTokens: number; limit: number };

export { GeminiFunctionCall, ProviderToolContext, Image, Declaration, LlmInput, LlmReply, Llm };
