import type { ToolCtx } from '../tools.js';
import type { Actor, Chat } from '../permissions.js';
import type { CallOrigin } from '../tool-execution.js';
import type { SafeRefs, RefKind } from '../safe-refs.js';

export type EvaluationStatus = 'allow' | 'denied' | 'needs_confirmation' | 'needs_clarification' | 'not_found';
export interface ExecutionContextV2 {
  readonly legacy: ToolCtx;
  readonly turnId: string;
  readonly sourceMessageId: string;
  readonly actor: Actor;
  readonly chat: Chat;
  readonly actorId: string;
  readonly chatId: string;
  readonly role: Actor['role'];
  readonly callOrigin: CallOrigin;
  readonly providerCallId: string | null;
  readonly executionKey: string;
  readonly logicalActionId: string;
  readonly parentExecutionId: string | null;
  readonly safeRefMap: SafeRefs;
  readonly now: Date;
  readonly confirmedArgsHash: string | null;
}
export interface PolicyDecision {
  readonly status: EvaluationStatus;
  readonly resolvedArgs: Record<string, unknown>;
  readonly denialCode: string | null;
  readonly confirmationSummary: string | null;
  readonly argsHash: string;
  readonly resourceState: readonly string[];
  readonly ownership: readonly { kind: RefKind; id: string; ownerId: string | null; own: boolean }[];
  readonly resolvedSafeRefs: readonly { ref: string; kind: RefKind; id: string }[];
  readonly gates: readonly string[];
}
export type BackendCall = {
  callOrigin: CallOrigin;
  providerCallId?: string;
  safeRefMap: SafeRefs;
  /** Backend confirmation store key, never a model argument. */
  confirmationId?: string;
  toolExposureCount?: number;
};
