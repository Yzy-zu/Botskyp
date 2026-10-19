import { z } from 'zod';
import { product } from '../../../config/product.js';
import type { FailureKind, LlmInput, LlmReply, NormalizedAssistantTurn, RateLimitTelemetry } from './types.js';
import type { LlmProviderAdapter } from './provider-adapter.js';
import { llmInputToOpenAiMessages, openAiToolsFromDeclarations } from './provider-adapter.js';
import { ProviderAttemptError, retryAfterMs } from './credential-pool.js';
import { getModelCapability } from './capability-matrix.js';

const openAiToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const openAiResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().optional(),
    message: z.object({
      role: z.string().optional(),
      content: z.string().nullable().optional(),
      tool_calls: z.array(openAiToolCallSchema).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
});

const openAiErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.string().optional(),
  }).optional(),
});

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

export class GroqProvider implements LlmProviderAdapter {
  readonly id = 'groq' as const;
  private readonly baseUrl: string;
  private lastTelemetry = new Map<string, RateLimitTelemetry>();

  constructor(
    private readonly configuredModels: readonly string[],
    private readonly http: typeof fetch = fetch,
    baseUrl = 'https://api.groq.com/openai/v1',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  listConfiguredModels(): string[] {
    return [...this.configuredModels];
  }

  canHandle(request: LlmInput, model: string): boolean {
    if (!this.configuredModels.includes(model)) return false;
    const cap = getModelCapability('groq', model);
    if (!cap.enabled) return false;
    if (request.tools && request.tools.length > 0 && !cap.supportsTools) return false;
    return true;
  }

  getLastTelemetry(credentialId: string): RateLimitTelemetry | undefined {
    return this.lastTelemetry.get(credentialId);
  }

  normalizeResponse(raw: unknown, model: string): NormalizedAssistantTurn {
    const parsed = openAiResponseSchema.parse(raw);
    const choice = parsed.choices[0];
    if (!choice) throw new ProviderAttemptError('invalid');

    const message = choice.message;
    const text = message.content ?? '';
    const toolCalls = (message.tool_calls ?? []).map(tc => {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        args,
      };
    });

    return {
      provider: 'groq',
      model: parsed.model || model,
      text,
      toolCalls,
      providerState: message,
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
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<LlmReply> {
    const reqSignal = AbortSignal.any([
      AbortSignal.timeout(product.llmTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const messages = llmInputToOpenAiMessages(input, false);
    const tools = input.tools.length ? openAiToolsFromDeclarations(input.tools) : undefined;
    const tool_choice = input.requireFunctionCall ? 'required' : tools ? 'auto' : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: product.llmMaxOutputTokens,
      ...(tools ? { tools, tool_choice } : {}),
      ...(input.responseJsonSchema ? { response_format: { type: 'json_object' } } : {}),
    };

    const started = performance.now();
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: reqSignal,
      });
    } catch (error) {
      const timeout = isTimeout(error, reqSignal);
      throw new ProviderAttemptError(timeout ? 'timeout' : 'provider');
    }

    const latencyMs = Math.round(performance.now() - started);

    // Extract rate-limit telemetry headers (never log or store apiKey)
    const retryHeader = response.headers.get('retry-after');
    const retryMs = retryAfterMs(retryHeader);
    const limitReq = Number(response.headers.get('x-ratelimit-limit-requests')) || undefined;
    const remReq = Number(response.headers.get('x-ratelimit-remaining-requests')) || undefined;
    const resetReq = response.headers.get('x-ratelimit-reset-requests');

    let resetMs: number | undefined;
    if (resetReq) {
      // Groq headers can be delta e.g. "6m0s" or seconds
      const secMatch = resetReq.match(/^(\d+(?:\.\d+)?)s?$/);
      if (secMatch) resetMs = Number(secMatch[1]) * 1000;
    }

    this.lastTelemetry.set(credentialId, {
      provider: 'groq',
      credentialId,
      model,
      httpStatus: response.status,
      retryAfterMs: retryMs,
      limit: limitReq,
      remaining: remReq,
      resetMs,
      latencyMs,
    });

    if (!response.ok) {
      let errorCode: string | undefined;
      let errorType: string | undefined;
      try {
        const rawError = await response.json();
        const parsed = openAiErrorSchema.safeParse(rawError);
        if (parsed.success && parsed.data.error) {
          errorCode = parsed.data.error.code;
          errorType = parsed.data.error.type;
        }
      } catch (err) {
        if (isTimeout(err, reqSignal)) throw new ProviderAttemptError('timeout');
      }

      if (response.status === 429) {
        throw new ProviderAttemptError('quota', 429, retryMs ?? resetMs, errorCode);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAttemptError('auth', response.status, undefined, errorCode || errorType);
      }
      if (response.status >= 500) {
        throw new ProviderAttemptError('provider', response.status, retryMs, errorCode);
      }
      if (response.status === 400 && (errorCode === 'model_decommissioned' || errorType === 'invalid_request_error')) {
        throw new ProviderAttemptError('incompatible', 400, undefined, errorCode);
      }
      throw new ProviderAttemptError('invalid', response.status, undefined, errorCode);
    }

    let result: z.infer<typeof openAiResponseSchema>;
    try {
      const raw = await response.json();
      result = openAiResponseSchema.parse(raw);
    } catch (error) {
      const timeout = isTimeout(error, reqSignal);
      throw new ProviderAttemptError(timeout ? 'timeout' : 'invalid');
    }

    const choice = result.choices[0];
    if (!choice) throw new ProviderAttemptError('invalid');

    const msg = choice.message;
    const text = msg.content ?? '';
    const calls = (msg.tool_calls ?? []).map(tc => {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        args,
      };
    });

    return {
      text,
      calls,
      content: msg,
      provider: 'groq',
      model: result.model || model,
      providerState: msg,
      usage: {
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
      },
    };
  }
}
