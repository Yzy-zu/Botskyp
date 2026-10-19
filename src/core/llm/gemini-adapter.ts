import { z } from 'zod';
import { product } from '../../../config/product.js';
import { geminiContentSchema, geminiToolContext, type GeminiContent, type GeminiFunctionCall } from '../provider-tool-context.js';
import type { FailureKind, LlmInput, LlmReply, NormalizedAssistantTurn } from './types.js';
import type { LlmProviderAdapter } from './provider-adapter.js';
import { ProviderAttemptError, retryAfterMs } from './credential-pool.js';

const responseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: geminiContentSchema.optional(),
    groundingMetadata: z.object({
      groundingChunks: z.array(z.object({
        web: z.object({ uri: z.string(), title: z.string().optional() }).optional(),
      })).optional(),
    }).optional(),
  })).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
  }).optional(),
});

const errorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }).optional(),
});

const safetySettings = ['HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT', 'HARASSMENT'].map(category => ({
  category: `HARM_CATEGORY_${category}`,
  threshold: 'OFF',
}));

const blockedReasons = new Set([
  'SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION', 'SPII',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION', 'PUP_LIMITED_DISABLED',
]);

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

export class GeminiProvider implements LlmProviderAdapter {
  readonly id = 'gemini' as const;

  constructor(
    private readonly configuredModels: readonly string[],
    private readonly http: typeof fetch = fetch,
  ) {}

  listConfiguredModels(): string[] {
    return [...this.configuredModels];
  }

  canHandle(_request: LlmInput, model: string): boolean {
    return this.configuredModels.includes(model);
  }

  normalizeResponse(raw: unknown, model: string): NormalizedAssistantTurn {
    const parsed = responseSchema.parse(raw);
    const candidate = parsed.candidates?.[0];
    const content = candidate?.content;
    const parts = content?.parts ?? [];
    const text = parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
    const calls = parts.flatMap(p => p.functionCall ? [p.functionCall] : []);

    return {
      provider: 'gemini',
      model,
      text,
      toolCalls: calls.map(c => ({ id: c.id, name: c.name, args: c.args })),
      providerState: content,
    };
  }

  classifyError(error: unknown, status?: number): {
    kind: FailureKind;
    retryable: boolean;
    retryAfterMs?: number;
    providerErrorCode?: string;
  } {
    if (status === 429) {
      return { kind: 'quota', retryable: true };
    }
    if (status === 401 || status === 403) {
      return { kind: 'auth', retryable: false };
    }
    if (status !== undefined && status >= 500) {
      return { kind: 'provider', retryable: true };
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { kind: 'timeout', retryable: true };
    }
    return { kind: 'provider', retryable: false };
  }

  async generate(
    input: LlmInput,
    model: string,
    apiKey: string,
    _credentialId: string,
    signal?: AbortSignal,
  ): Promise<LlmReply> {
    const hasImage = JSON.stringify(input.contents, (key, value: unknown) => key === 'data' ? '[bytes]' : value).includes('"inlineData"');
    const reqSignal = AbortSignal.any([
      AbortSignal.timeout(hasImage ? product.llmVisionTimeoutMs : product.llmTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    let response: Response;
    try {
      response = await this.http(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: input.contents,
          safetySettings,
          generationConfig: {
            maxOutputTokens: product.llmMaxOutputTokens,
            ...(input.responseJsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: input.responseJsonSchema } : {}),
          },
          ...((input.requireFunctionCall || input.validateFunctionCalls) && input.tools.length
            ? {
                toolConfig: {
                  functionCallingConfig: {
                    mode: input.requireFunctionCall ? 'ANY' : 'VALIDATED',
                    ...(input.validateFunctionCalls ? { allowedFunctionNames: input.tools.map(tool => tool.name) } : {}),
                  },
                },
              }
            : {}),
          ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools }] } : {}),
        }),
        signal: reqSignal,
        redirect: 'error',
      });
    } catch (error) {
      const timeout = isTimeout(error, reqSignal);
      throw new ProviderAttemptError(timeout ? 'timeout' : 'provider');
    }

    if (!response.ok) {
      const retryMs = retryAfterMs(response.headers.get('retry-after'));
      let invalidKey = false;
      let errorCode: string | undefined;

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        try {
          const rawError = await response.json();
          const details = errorSchema.safeParse(rawError);
          if (details.success && details.data.error) {
            errorCode = details.data.error.message || details.data.error.details?.map(d => d.reason).filter(Boolean).join(',');
            if (details.data.error.details) {
              invalidKey = details.data.error.details.some(d => d.reason === 'API_KEY_INVALID');
            }
          }
        } catch (err) {
          if (isTimeout(err, reqSignal)) {
            throw new ProviderAttemptError('timeout');
          }
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }

      if (response.status === 429) {
        throw new ProviderAttemptError('quota', 429, retryMs);
      }
      if (invalidKey || response.status === 401 || response.status === 403) {
        throw new ProviderAttemptError('auth', 401, undefined, errorCode);
      }
      throw new ProviderAttemptError('provider', response.status, retryMs, errorCode);
    }

    let result: z.infer<typeof responseSchema>;
    try {
      const raw = await response.json();
      result = responseSchema.parse(raw);
    } catch (error) {
      const timeout = isTimeout(error, reqSignal);
      throw new ProviderAttemptError(timeout ? 'timeout' : 'invalid');
    }

    const candidate = result.candidates?.[0];
    const finish = candidate?.finishReason;
    const blocked = Boolean(result.promptFeedback?.blockReason) || blockedReasons.has(finish ?? '');

    if (blocked) {
      throw new ProviderAttemptError('blocked');
    }
    if (!candidate?.content) {
      throw new ProviderAttemptError('invalid');
    }

    const content: GeminiContent = candidate.content;
    const parts = content.parts ?? [];
    const text = parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
    const calls: GeminiFunctionCall[] = parts.flatMap(p => p.functionCall ? [p.functionCall] : []);

    return {
      text,
      calls,
      content,
      provider: 'gemini',
      model,
      providerState: content,
      providerContext: geminiToolContext(content),
      usage: {
        inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
