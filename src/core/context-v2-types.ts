import type { ExecutionContextV2 } from './policy-v2/types.js';
import type { SafeRef, SafeRefs } from './safe-refs.js';
import type { SessionV2 } from './sessions-v2.js';
export type SafeArtifactV2 = { ref: SafeRef | 'A_CURRENT' | 'A_REPLY' | 'A_LAST'; kind: string; mime: string; filename?: string; bytes?: number };
export type CurrentUserTurnV2 = {
  userText: string; quotedText?: string; quotedAuthorRef?: SafeRef; attachedArtifactRef?: 'A_CURRENT'; mentions: SafeRef[];
};
export type SafeConversationSnapshotV2 = {
  nowLocal: string;
  actor: { ref: 'SELF'; displayName: string; role: string };
  chat: { type: 'group' | 'private'; availableModules: string[] };
  activeSession?: { kind: SessionV2['kind']; prompt: string; missingSlots: string[]; expiresLocal: string; preview?: { description: string; text?: string; count?: number } };
  currentAttachment?: { kind: string; mime?: string };
  currentArtifact?: SafeArtifactV2;
  visionArtifact?: SafeArtifactV2;
  quotedMessage?: { text?: string; authorRef?: SafeRef; artifactRef?: 'A_REPLY'; artifact?: SafeArtifactV2 };
  recentArtifacts: SafeArtifactV2[];
  notes: { ref: SafeRef; text: string }[];
  reminders: { ref: SafeRef; text: string; dueLocal: string }[];
  poll?: { ref: 'P_ACTIVE'; pollRef: SafeRef; question: string; options: string[]; status: 'open' };
  game?: { kind: string; status: string; yourHand?: number; dealerVisible?: number };
  cooperacha?: { status: 'open'; totalXp: number; goalXp: number; category: string };
  school: { ref: SafeRef; kind: 'subject' | 'task'; label: string; dueLocal?: string }[];
  members: { ref: SafeRef; displayName: string }[];
  personalMemoryAvailable: boolean;
  personalMemories: { ref: SafeRef; text: string }[];
  recentResults: { ref: 'R_LAST' | `R_${number}`; kind: string; excerpt: string; ageSec: number }[];
  recentEvents: { kind: 'resolved_event'; summary: string; ageSec: number }[];
  recentDialogue?: { role: 'user' | 'bot'; text: string }[];
};
export type ContextEnvelopeV2 = {
  SYSTEM_RULES: readonly string[];
  REFERENCE_DATA: SafeConversationSnapshotV2;
  CURRENT_USER_TURN: CurrentUserTurnV2;
};
/** Only envelope is model-facing. Runtime and the scoped map must never be serialized into a prompt. */
export type TurnContextV2 = {
  runtime: Pick<ExecutionContextV2, 'turnId' | 'sourceMessageId' | 'now' | 'actor' | 'chat' | 'role'> & { timezone: string; enabledModules: string[]; routerMode: string };
  envelope: ContextEnvelopeV2;
  safeRefMap: SafeRefs;
  metrics: { contextChars: number; estimatedTokens: number; artifactCount: number; selectedArtifactKind: string | null;
    sessionKind: string | null; sessionDecision: string; activeEntityKinds: string[] };
};
