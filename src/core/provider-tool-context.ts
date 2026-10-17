import { z } from 'zod';

export const geminiFunctionCallSchema = z.object({
  id: z.string().optional(), name: z.string(), args: z.unknown().optional(),
}).passthrough();
export const geminiPartSchema = z.object({
  text: z.string().optional(), thought: z.boolean().optional(), thoughtSignature: z.string().optional(),
  functionCall: geminiFunctionCallSchema.optional(),
}).passthrough();
export const geminiContentSchema = z.object({
  role: z.string().optional(), parts: z.array(geminiPartSchema),
}).passthrough();
export type GeminiFunctionCall = z.infer<typeof geminiFunctionCallSchema>;
export type GeminiContent = z.infer<typeof geminiContentSchema>;
export type ProviderToolContext = {
  provider: 'gemini';
  /** Echo the complete content, in order, without merging/rebuilding parts or signatures. */
  modelContent: GeminiContent;
  calls: { partIndex: number; call: GeminiFunctionCall }[];
};
export function geminiToolContext(content: GeminiContent): ProviderToolContext {
  return { provider: 'gemini', modelContent: content, calls: content.parts.flatMap((part, partIndex) =>
    part.functionCall ? [{ partIndex, call: part.functionCall }] : []) };
}
/** Prepared for R2; missing provider IDs stay absent, never synthesized. */
export function geminiFunctionResult(call: GeminiFunctionCall, response: Record<string, unknown>) {
  return { functionResponse: { name: call.name, ...(call.id === undefined ? {} : { id: call.id }), response } };
}
