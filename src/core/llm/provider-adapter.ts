import type {
  ProviderId,
  FailureKind,
  LlmInput,
  LlmReply,
  NormalizedAssistantTurn,
  NormalizedToolCall,
} from './types.js';
import type { CredentialState } from './credential-pool.js';
import { geminiContentSchema, type GeminiContent } from '../provider-tool-context.js';

export interface LlmProviderAdapter {
  readonly id: ProviderId;
  listConfiguredModels(): string[];
  canHandle(request: LlmInput, model: string): boolean;
  generate(
    request: LlmInput,
    model: string,
    apiKey: string,
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<LlmReply>;
  normalizeResponse(raw: unknown, model: string): NormalizedAssistantTurn;
  classifyError(error: unknown, status?: number): {
    kind: FailureKind;
    retryable: boolean;
    retryAfterMs?: number;
    providerErrorCode?: string;
  };
  rateLimitState?(credentialId: string): CredentialState | undefined;
}

export type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Translates arbitrary LlmInput contents into OpenAI chat messages format.
 * Strips any Gemini-specific properties (e.g. thoughtSignature, inlineData)
 * and reconstructs proper OpenAI assistant tool_calls and tool result messages.
 */
export function llmInputToOpenAiMessages(input: LlmInput, supportsVision = false): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: input.system },
  ];

  let pendingToolCalls: NormalizedToolCall[] = [];

  for (const item of input.contents as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;

    // Direct OpenAI message already formatted
    if (typeof item.role === 'string' && (item.content !== undefined || item.tool_calls !== undefined)) {
      messages.push(item as unknown as OpenAiMessage);
      continue;
    }

    // Gemini Content format { role: 'user' | 'model', parts: [...] }
    if (Array.isArray(item.parts)) {
      const parts = item.parts as Array<Record<string, unknown>>;
      const role = item.role === 'model' ? 'assistant' : 'user';

      if (role === 'assistant') {
        const textParts = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text as string);
        const functionCalls = parts
          .filter(p => p.functionCall && typeof p.functionCall === 'object')
          .map(p => p.functionCall as { id?: string; name: string; args?: unknown });

        const tool_calls: OpenAiToolCall[] = functionCalls.map((fc, idx) => {
          const id = fc.id || `call_${idx}_${Date.now()}`;
          return {
            id,
            type: 'function',
            function: {
              name: fc.name,
              arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {}),
            },
          };
        });

        pendingToolCalls = functionCalls.map((fc, idx) => ({
          id: tool_calls[idx]?.id,
          name: fc.name,
          args: fc.args,
        }));

        messages.push({
          role: 'assistant',
          content: textParts.length ? textParts.join('') : null,
          ...(tool_calls.length ? { tool_calls } : {}),
        });
      } else {
        // user turn: might contain text, functionResponses, and/or inlineData
        const functionResponses = parts
          .filter(p => p.functionResponse && typeof p.functionResponse === 'object')
          .map(p => p.functionResponse as { name?: string; id?: string; response?: unknown });

        if (functionResponses.length > 0) {
          // Add tool messages corresponding to each function response
          for (const fr of functionResponses) {
            let matchedId = fr.id;
            if (!matchedId) {
              const matchedCall = pendingToolCalls.find(tc => tc.name === fr.name);
              matchedId = matchedCall?.id || 'call_default';
            }
            messages.push({
              role: 'tool',
              tool_call_id: matchedId,
              content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? {}),
            });
          }
          pendingToolCalls = [];
        }

        const textParts = parts.filter(p => typeof p.text === 'string').map(p => p.text as string);
        const imageParts = parts.filter(p => p.inlineData && typeof p.inlineData === 'object');

        if (textParts.length > 0 || imageParts.length > 0) {
          if (supportsVision && imageParts.length > 0) {
            const contentItems: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
            if (textParts.length > 0) {
              contentItems.push({ type: 'text', text: textParts.join('') });
            }
            for (const img of imageParts) {
              const inline = img.inlineData as { mimeType: string; data: string };
              contentItems.push({
                type: 'image_url',
                image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
              });
            }
            messages.push({ role: 'user', content: contentItems });
          } else {
            messages.push({ role: 'user', content: textParts.join('') });
          }
        }
      }
    }
  }

  return messages;
}

/**
 * Normalizes OpenAI function tools into declaration list.
 */
export function openAiToolsFromDeclarations(tools: LlmInput['tools']): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema,
    },
  }));
}

/**
 * Validates whether an object is a Gemini content structure.
 */
export function isGeminiContent(content: unknown): content is GeminiContent {
  return geminiContentSchema.safeParse(content).success;
}
