import { createHash } from 'node:crypto';
import { z } from 'zod';
import { argumentHash } from './sessions.js';

export const callOrigins = ['llm', 'fast_path', 'session', 'internal'] as const;
export type CallOrigin = typeof callOrigins[number];
const identitySchema = z.strictObject({
  turnId: z.uuid(), chatId: z.string().min(1), actorId: z.string().min(1),
  sourceMessageId: z.string().min(1), toolName: z.string().min(1),
  argsHash: z.string().regex(/^[a-f0-9]{64}$/), callOrigin: z.enum(callOrigins),
  providerCallId: z.string().min(1).optional(),
}).refine(value => value.callOrigin === 'llm' || value.providerCallId === undefined);
export type ExecutionIdentity = z.infer<typeof identitySchema>;

/** Backend identity, independent of Gemini IDs and stable across retries/restarts. */
export function executionKey(input: ExecutionIdentity): string {
  const v = identitySchema.parse(input);
  return createHash('sha256').update(JSON.stringify([
    'botsky-execution-v1', v.turnId, v.chatId, v.actorId, v.sourceMessageId,
    v.toolName, v.argsHash, v.callOrigin, v.providerCallId ?? null,
  ])).digest('hex');
}
export const executionArgsHash = argumentHash;
