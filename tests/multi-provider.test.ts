import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialPool, ProviderAttemptError } from '../src/core/llm/credential-pool.js';
import { GroqProvider } from '../src/core/llm/groq-adapter.js';
import { OpenRouterProvider } from '../src/core/llm/openrouter-adapter.js';
import { MultiProviderRouter } from '../src/core/llm/router.js';
import { tokenPreflight, estimateRequestTokens } from '../src/core/llm/preflight.js';
import { getModelCapability, setModelCapabilityOverride, clearModelCapabilityOverrides } from '../src/core/llm/capability-matrix.js';
import { llmInputToOpenAiMessages } from '../src/core/llm/provider-adapter.js';
import { LlmUnavailable } from '../src/core/quota.js';
import type { LlmInput } from '../src/core/llm/types.js';
import type { Config } from '../src/config.js';

describe('Multi-Provider LLM Backend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearModelCapabilityOverrides();
  });

  describe('CredentialPool & Secrets', () => {
    it('parses arbitrary N credentials and assigns opaque IDs without leaking secrets', () => {
      const keys = ['key-alpha-1234', 'key-beta-5678', 'key-gamma-9012'];
      const pool = new CredentialPool(keys, { providerPrefix: 'gemini' });

      expect(pool.keyCount).toBe(3);
      const snapshot = pool.snapshot();
      expect(snapshot.keys).toHaveLength(3);
      expect(snapshot.keys[0]!.id).toBe('gemini-key-1');
      expect(snapshot.keys[1]!.id).toBe('gemini-key-2');
      expect(snapshot.keys[2]!.id).toBe('gemini-key-3');

      // Crucial: No secret is exposed in JSON or logs
      const serialized = JSON.stringify(snapshot);
      for (const k of keys) {
        expect(serialized).not.toContain(k);
      }
    });

    it('429 triggers cooldown and fails over to next available credential', () => {
      const pool = new CredentialPool(['key-1', 'key-2'], { providerPrefix: 'gemini' });
      const c1 = pool.selectCandidate();
      expect(c1?.state.id).toBe('gemini-key-1');

      // Record 429
      pool.recordFailure(1, new ProviderAttemptError('quota', 429, 5000), 100);

      // Next acquisition should pick key-2 because key-1 is cooling
      const c2 = pool.selectCandidate();
      expect(c2?.state.id).toBe('gemini-key-2');
    });

    it('success resets consecutive failures and consecutive 429 counters', () => {
      const pool = new CredentialPool(['key-1'], { providerPrefix: 'gemini' });
      pool.recordFailure(1, new ProviderAttemptError('provider', 500), 100);
      let snap = pool.snapshot().keys[0]!;
      expect(snap.consecutiveErrors).toBe(1);

      pool.recordSuccess(1, 250);
      snap = pool.snapshot().keys[0]!;
      expect(snap.consecutiveErrors).toBe(0);
      expect(snap.consecutive429).toBe(0);
      expect(snap.available).toBe(true);
    });

    it('auth failure permanently disables credential until reload', () => {
      const pool = new CredentialPool(['bad-auth-key', 'valid-key'], { providerPrefix: 'gemini' });
      pool.recordFailure(1, new ProviderAttemptError('auth', 401), 100);

      const snap = pool.snapshot().keys;
      expect(snap[0]!.available).toBe(false);

      // Only valid-key should be acquired
      const next = pool.selectCandidate();
      expect(next?.state.id).toBe('gemini-key-2');
    });

    it('respects Retry-After header for cooldown duration', () => {
      const pool = new CredentialPool(['key-1'], { providerPrefix: 'gemini' });
      pool.recordFailure(1, new ProviderAttemptError('quota', 429, 12000), 100);

      const snap = pool.snapshot().keys[0]!;
      expect(snap.cooldownUntil).toBeGreaterThan(Date.now() + 10000);
      expect(pool.selectCandidate()).toBeUndefined();
    });
  });

  describe('Groq Adapter', () => {
    it('normalizes OpenAI-compatible response and tool calls with exact arguments', async () => {
      const mockFetch = vi.fn<typeof fetch>(async () => Response.json({
        id: 'chatcmpl-123',
        model: 'llama-3.3-70b-versatile',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_groq_1',
              type: 'function',
              function: {
                name: 'minecraft_status',
                arguments: JSON.stringify({ verbose: true }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 25 },
      }, {
        headers: {
          'x-ratelimit-remaining-requests': '14',
          'x-ratelimit-remaining-tokens': '5900',
        },
      }));

      const adapter = new GroqProvider(['llama-3.3-70b-versatile'], mockFetch);
      const req: LlmInput = {
        system: 'System prompt',
        contents: [{ role: 'user', parts: [{ text: 'status please' }] }],
        tools: [{ name: 'minecraft_status', description: 'test', parametersJsonSchema: {} }],
      };

      const reply = await adapter.generate(req, 'llama-3.3-70b-versatile', 'gsk-test', 'groq-key-1');
      expect(reply.calls).toHaveLength(1);
      expect(reply.calls[0]!.name).toBe('minecraft_status');
      expect(reply.calls[0]!.id).toBe('call_groq_1');
      expect(reply.calls[0]!.args).toEqual({ verbose: true });
      expect(reply.provider).toBe('groq');

      // Check telemetry headers captured
      const telemetry = adapter.getLastTelemetry('groq-key-1');
      expect(telemetry?.remaining).toBe(14);
    });

    it('rejects unsupported or disabled model cleanly', async () => {
      setModelCapabilityOverride('groq', 'incompatible-model', {
        supportsTools: false,
        enabled: false,
      });

      const adapter = new GroqProvider(['incompatible-model']);
      expect(adapter.canHandle({ system: '', contents: [], tools: [] }, 'incompatible-model')).toBe(false);
    });
  });

  describe('OpenRouter Adapter', () => {
    it('translates provider errors (402 payment, 429 quota) appropriately', async () => {
      const mockFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: { message: 'Insufficient credits', code: 402 },
      }), { status: 402 }));

      const adapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b-instruct'], false, mockFetch);
      const req: LlmInput = {
        system: 'System prompt',
        contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
        tools: [],
      };

      await expect(adapter.generate(req, 'meta-llama/llama-3.3-70b-instruct', 'sk-or-test', 'openrouter-key-1'))
        .rejects.toThrow(ProviderAttemptError);
    });

    it('rejects free model if OPENROUTER_ALLOW_FREE_MODELS is false', () => {
      const adapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b-instruct:free'], false);
      expect(adapter.canHandle({ system: '', contents: [], tools: [] }, 'meta-llama/llama-3.3-70b-instruct:free')).toBe(false);
    });

    it('allows free model if OPENROUTER_ALLOW_FREE_MODELS is true and model has tool capability', () => {
      setModelCapabilityOverride('openrouter', 'meta-llama/llama-3.3-70b-instruct:free', {
        supportsTools: true,
        fullCatalogCompatible: true,
        enabled: true,
      });

      const adapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b-instruct:free'], true);
      expect(adapter.canHandle({ system: '', contents: [], tools: [] }, 'meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    });
  });

  describe('Protocol Normalization & Thought Signature Isolation', () => {
    it('strips Gemini-specific thoughtSignature and converts turns to OpenAI schema without leaks', () => {
      const input: LlmInput = {
        system: 'Eres Botsky.',
        contents: [
          { role: 'user', parts: [{ text: 'hola' }] },
          {
            role: 'model',
            parts: [
              { thought: true, text: 'internal thought', thoughtSignature: 'gemini-opaque-sig-12345' },
              { functionCall: { name: 'minecraft_status', args: {}, id: 'call_1' }, thoughtSignature: 'sig-part' },
            ],
          },
          {
            role: 'user',
            parts: [{
              functionResponse: { name: 'minecraft_status', id: 'call_1', response: { online: true } },
            }],
          },
        ],
        tools: [],
      };

      const messages = llmInputToOpenAiMessages(input);
      const serialized = JSON.stringify(messages);

      // Verify thought signatures are stripped completely
      expect(serialized).not.toContain('gemini-opaque-sig-12345');
      expect(serialized).not.toContain('sig-part');

      // Verify OpenAI tool format reconstructed
      expect(messages[0]).toEqual({ role: 'system', content: 'Eres Botsky.' });
      expect(messages[1]).toEqual({ role: 'user', content: 'hola' });
      expect(messages[2]?.role).toBe('assistant');
      const asst = messages[2] as { role: string; tool_calls?: Array<{ function: { name: string } }> };
      expect(asst.tool_calls?.[0]?.function.name).toBe('minecraft_status');
      expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ online: true }) });
    });
  });

  describe('Token Preflight', () => {
    it('estimates token count reasonably and rejects request when exceeding context window', () => {
      const hugeSystem = 'a'.repeat(200_000);
      const req: LlmInput = {
        system: hugeSystem,
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
        tools: [],
      };

      const estimated = estimateRequestTokens(req);
      expect(estimated).toBeGreaterThan(40_000);

      // Preflight against small context model (e.g. 16k context)
      const cap = { ...getModelCapability('groq', 'llama-3.1-8b-instant'), contextWindow: 16_000 };
      const preflight = tokenPreflight(cap, req);
      expect(preflight.ok).toBe(false);
      if (!preflight.ok) {
        expect(preflight.reason).toBe('MODEL_REQUEST_TOO_LARGE');
      }
    });

    it('passes preflight when request fits comfortably within model limits', () => {
      const req: LlmInput = {
        system: 'Short system',
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
        tools: [],
      };

      const cap = getModelCapability('gemini', 'gemini-3.5-flash-lite');
      const preflight = tokenPreflight(cap, req);
      expect(preflight.ok).toBe(true);
    });
  });

  describe('MultiProviderRouter', () => {
    const baseConfig = {
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_API_KEYS: ['test-gemini-key-1', 'test-gemini-key-2'],
      GEMINI_MODEL: 'gemini-3.5-flash-lite' as const,
      GEMINI_MODELS: ['gemini-3.5-flash-lite'],
      GEMINI_FREE_TIER_CONFIRMED: true,
      GROQ_ENABLED: true,
      GROQ_API_KEY: 'gsk-key',
      GROQ_API_KEYS: ['gsk-key-1'],
      GROQ_MODELS: ['llama-3.3-70b-versatile'],
      OPENROUTER_ENABLED: true,
      OPENROUTER_API_KEY: 'sk-or-key',
      OPENROUTER_API_KEYS: ['sk-or-key-1'],
      OPENROUTER_MODELS: ['meta-llama/llama-3.3-70b-instruct'],
      OPENROUTER_ALLOW_FREE_MODELS: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite,groq/llama-3.3-70b-versatile,openrouter/meta-llama/llama-3.3-70b-instruct',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    it('routes to primary provider when healthy', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Gemini primary reply' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }));

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const reply = await router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
        tools: [],
      });

      expect(reply.text).toBe('Gemini primary reply');
      expect(reply.provider).toBe('gemini');
      expect(mockHttp).toHaveBeenCalledOnce();
    });

    it('fails over to secondary provider upon 429 without retrying failing candidate', async () => {
      let callCount = 0;
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        callCount++;
        const urlStr = String(url);
        // Gemini fails with 429
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(null, { status: 429 });
        }
        // Groq succeeds
        if (urlStr.includes('api.groq.com')) {
          return Response.json({
            choices: [{
              message: { role: 'assistant', content: 'Groq fallback reply' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 6 },
          });
        }
        return new Response(null, { status: 500 });
      });

      // Allow Groq to be agent compatible for this test
      setModelCapabilityOverride('groq', 'llama-3.3-70b-versatile', {
        supportsTools: true,
        fullCatalogCompatible: true,
        enabled: true,
      });

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const reply = await router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
        tools: [],
      });

      expect(reply.text).toBe('Groq fallback reply');
      expect(reply.provider).toBe('groq');
      // Should have tried Gemini first, then failed over to Groq
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('enforces LLM_MAX_PROVIDER_ATTEMPTS limit strictly', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));

      const router = new MultiProviderRouter({
        ...baseConfig,
        LLM_MAX_PROVIDER_ATTEMPTS: 2,
      } as unknown as Config, { http: mockHttp });

      await expect(router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
        tools: [],
      })).rejects.toThrow(LlmUnavailable);

      // Max attempts = 2, so http shouldn't exceed 2 calls
      expect(mockHttp).toHaveBeenCalledTimes(2);
    });

    it('preserves turn stickiness across assistant continuation turns', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes('generativelanguage.googleapis.com')) {
          return Response.json({
            candidates: [{
              content: { role: 'model', parts: [{ text: 'Continued turn' }] },
              finishReason: 'STOP',
            }],
          });
        }
        return new Response(null, { status: 500 });
      });

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const input: LlmInput = {
        turnId: 'turn-sticky-1',
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
        tools: [],
      };

      const reply1 = await router.generate(input);
      expect(reply1.provider).toBe('gemini');

      // Next call with same turnId must stick to Gemini
      const reply2 = await router.generate({ ...input, contents: [...input.contents, { role: 'model', parts: [{ text: 'ok' }] }] });
      expect(reply2.provider).toBe('gemini');
    });
  });
});
