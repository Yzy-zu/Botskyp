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
    code: z.union([z.string(), z.number()]).optional(),
  }).optional(),
});

const modelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    context_length: z.number().optional(),
    pricing: z.object({
      prompt: z.union([z.string(), z.number()]).optional(),
      completion: z.union([z.string(), z.number()]).optional(),
    }).optional(),
    supported_parameters: z.array(z.string()).optional(),
  })),
});

export type DiscoveredModel = {
  id: string;
  name: string;
  contextLength: number;
  isFree: boolean;
  supportsTools: boolean;
};

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

export class OpenRouterProvider implements LlmProviderAdapter {
  readonly id = 'openrouter' as const;
  private readonly baseUrl: string;
  private lastTelemetry = new Map<string, RateLimitTelemetry>();
  private modelsCache: { expiresAt: number; models: DiscoveredModel[] } | undefined;
  private readonly cacheTtlMs = 3600_000; // 1 hour TTL

  constructor(
    private readonly configuredModels: readonly string[],
    private readonly allowFreeModels = false,
    private readonly http: typeof fetch = fetch,
    baseUrl = 'https://openrouter.ai/api/v1',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  listConfiguredModels(): string[] {
    return [...this.configuredModels];
  }

  canHandle(request: LlmInput, model: string): boolean {
    const isFree = model.endsWith(':free') || model.startsWith('openrouter/free');
    if (isFree && !this.allowFreeModels) return false;
    const cap = getModelCapability('openrouter', model);
    if (!cap.enabled) return false;
    if (request.tools && request.tools.length > 0 && !cap.supportsTools) return false;
    if (this.configuredModels.includes(model)) return true;
    if (this.allowFreeModels && this.modelsCache?.models.some(m => m.id === model && m.isFree && m.supportsTools)) {
      return true;
    }
    return false;
  }

  getLastTelemetry(credentialId: string): RateLimitTelemetry | undefined {
    return this.lastTelemetry.get(credentialId);
  }

  async discoverModels(apiKey?: string, forceRefresh = false): Promise<DiscoveredModel[]> {
    const now = Date.now();
    if (!forceRefresh && this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.models;
    }

    try {
      const headers: Record<string, string> = {
        'HTTP-Referer': 'https://botsky.chat',
        'X-Title': 'Botsky',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await this.http(`${this.baseUrl}/models`, { method: 'GET', headers });
      if (!res.ok) return this.modelsCache?.models ?? [];

      const raw = await res.json();
      const parsed = modelsResponseSchema.safeParse(raw);
      if (!parsed.success) return this.modelsCache?.models ?? [];

      const models: DiscoveredModel[] = parsed.data.data.map(m => {
        const promptCost = Number(m.pricing?.prompt ?? 0);
        const completionCost = Number(m.pricing?.completion ?? 0);
        const isFree = promptCost === 0 && completionCost === 0;
        const supportsTools = Boolean(m.supported_parameters?.includes('tools'));

        return {
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length ?? 4096,
          isFree,
          supportsTools,
        };
      });

      this.modelsCache = {
        expiresAt: now + this.cacheTtlMs,
        models,
      };
      return models;
    } catch {
      return this.modelsCache?.models ?? [];
    }
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
      provider: 'openrouter',
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
          'HTTP-Referer': 'https://botsky.chat',
          'X-Title': 'Botsky',
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
    const limit = Number(response.headers.get('x-ratelimit-limit')) || undefined;
    const remaining = Number(response.headers.get('x-ratelimit-remaining')) || undefined;
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const resetMs = resetHeader ? Number(resetHeader) * 1000 : undefined;

    this.lastTelemetry.set(credentialId, {
      provider: 'openrouter',
      credentialId,
      model,
      httpStatus: response.status,
      retryAfterMs: retryMs,
      limit,
      remaining,
      resetMs,
      latencyMs,
    });

    if (!response.ok) {
      let errorCode: string | undefined;
      try {
        const rawError = await response.json();
        const parsed = openAiErrorSchema.safeParse(rawError);
        if (parsed.success && parsed.data.error) {
          errorCode = String(parsed.data.error.code ?? parsed.data.error.message ?? '');
        }
      } catch (err) {
        if (isTimeout(err, reqSignal)) throw new ProviderAttemptError('timeout');
      }

      if (response.status === 429) {
        throw new ProviderAttemptError('quota', 429, retryMs, errorCode);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAttemptError('auth', response.status, undefined, errorCode);
      }
      if (response.status >= 500) {
        throw new ProviderAttemptError('provider', response.status, retryMs, errorCode);
      }
      if (response.status === 404 || response.status === 400) {
        throw new ProviderAttemptError('incompatible', response.status, undefined, errorCode);
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
      provider: 'openrouter',
      model: result.model || model,
      providerState: msg,
      usage: {
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
      },
    };
  }
}
