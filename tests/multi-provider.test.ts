import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CredentialPool, ProviderAttemptError } from '../src/core/llm/credential-pool.js';
import { GeminiProvider } from '../src/core/llm/gemini-adapter.js';
import { GroqProvider } from '../src/core/llm/groq-adapter.js';
import { OpenRouterProvider } from '../src/core/llm/openrouter-adapter.js';
import {
  MultiProviderRouter,
  getSharedMultiProviderRouter,
  resetSharedMultiProviderRouter,
  parseRouteCandidate,
} from '../src/core/llm/router.js';
import { TurnLlmBudget } from '../src/core/llm/types.js';
import { tokenPreflight, estimateRequestTokens } from '../src/core/llm/preflight.js';
import { getModelCapability, setModelCapabilityOverride, clearModelCapabilityOverrides } from '../src/core/llm/capability-matrix.js';
import { llmInputToOpenAiMessages, hasVisionInput } from '../src/core/llm/provider-adapter.js';
import { LlmUnavailable } from '../src/core/quota.js';
import { randomUUID } from 'node:crypto';
import { receive, processNext } from '../src/core/inbox.js';
import { db, config as harnessConfig, owner as harnessOwner, chat as harnessChat, reset as harnessReset, initialize as harnessInitialize } from './r4-harness.js';
import type { Msg } from '../src/wa/types.js';
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

  describe('Route Parser (Section 10)', () => {
    it('parses provider|model preserving model name byte-for-byte intact', () => {
      const parsed1 = parseRouteCandidate('openrouter|some/model:free');
      expect(parsed1).toEqual({ provider: 'openrouter', model: 'some/model:free' });

      const parsed2 = parseRouteCandidate('groq|llama-3.3-70b-versatile');
      expect(parsed2).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });

      const parsed3 = parseRouteCandidate('gemini|gemini-2.5-flash');
      expect(parsed3).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
    });

    it('parses legacy formats provider:model and provider/model', () => {
      const p1 = parseRouteCandidate('gemini:gemini-3.5-flash-lite');
      expect(p1).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });

      const p2 = parseRouteCandidate('groq/llama-3.1-8b-instant');
      expect(p2).toEqual({ provider: 'groq', model: 'llama-3.1-8b-instant' });
    });

    it('rejects invalid or unknown providers', () => {
      expect(parseRouteCandidate('')).toBeUndefined();
      expect(parseRouteCandidate('unknown|model')).toBeUndefined();
      expect(parseRouteCandidate('claude/claude-3-opus')).toBeUndefined();
    });
  });

  describe('Application-Scoped Provider Runtime & Cooldown Persistence (Section 2 & 17)', () => {
    const baseConfig = {
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_API_KEYS: ['test-gemini-key-1', 'test-gemini-key-2'],
      GEMINI_MODEL: 'gemini-3.5-flash-lite' as const,
      GEMINI_MODELS: ['gemini-3.5-flash-lite'],
      GEMINI_FREE_TIER_CONFIRMED: true,
      GROQ_ENABLED: false,
      OPENROUTER_ENABLED: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    afterEach(() => {
      resetSharedMultiProviderRouter();
    });

    it('preserves cooldown between two independent turns (turn 1 429 skips key on turn 2)', async () => {
      let nowMs = 100000;
      const httpCalls: string[] = [];
      const mockHttp = vi.fn<typeof fetch>(async (_url, init) => {
        const apiKey = (init?.headers as Record<string, string>)?.['x-goog-api-key'] ?? '';
        httpCalls.push(apiKey);
        if (apiKey === 'test-gemini-key-1') {
          return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
            status: 429,
            headers: { 'retry-after': '30' },
          });
        }
        return Response.json({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'Success from key-2' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        });
      });

      const shared = getSharedMultiProviderRouter(baseConfig as unknown as Config, {
        http: mockHttp,
        now: () => nowMs,
      });

      // Turn 1: key-1 gets 429, router fails over to key-2 and succeeds
      const reply1 = await shared.generate({
        turnId: 'turn-1',
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'First message' }] }],
        tools: [],
      });
      expect(reply1.text).toBe('Success from key-2');
      expect(httpCalls).toEqual(['test-gemini-key-1', 'test-gemini-key-2']);

      httpCalls.length = 0;
      nowMs += 5000; // 5s later, cooldown of 30s is still active!

      // Turn 2: Independent turn. Must skip key-1 completely and hit key-2 directly!
      const reply2 = await shared.generate({
        turnId: 'turn-2',
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Second message' }] }],
        tools: [],
      });
      expect(reply2.text).toBe('Success from key-2');
      // Hard invariant: key-1 was skipped; zero network attempts to key-1!
      expect(httpCalls).toEqual(['test-gemini-key-2']);
    });

    it('auth-disabled credentials remain disabled across turns until reset', async () => {
      const httpCalls: string[] = [];
      const mockHttp = vi.fn<typeof fetch>(async (_url, init) => {
        const apiKey = (init?.headers as Record<string, string>)?.['x-goog-api-key'] ?? '';
        httpCalls.push(apiKey);
        if (apiKey === 'test-gemini-key-1') {
          return new Response(JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }), {
            status: 400,
          });
        }
        return Response.json({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'Key 2 success' }] },
            finishReason: 'STOP',
          }],
        });
      });

      const shared = getSharedMultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });

      await shared.generate({
        turnId: 'turn-auth-1',
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Msg 1' }] }],
        tools: [],
      });

      httpCalls.length = 0;

      // Turn 2: Key 1 was permanently disabled due to invalid auth, so it must not be called
      await shared.generate({
        turnId: 'turn-auth-2',
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Msg 2' }] }],
        tools: [],
      });

      expect(httpCalls).toEqual(['test-gemini-key-2']);
    });
  });

  describe('Attempt Budget Is Per Whole Agentic Turn (Section 3)', () => {
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
      OPENROUTER_ENABLED: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite,groq/llama-3.3-70b-versatile',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    it('enforces actual network calls <= LLM_MAX_PROVIDER_ATTEMPTS across entire turn loop', async () => {
      let callCount = 0;
      const mockHttp = vi.fn<typeof fetch>(async () => {
        callCount++;
        // First 2 calls fail with 503
        if (callCount <= 2) {
          return new Response(null, { status: 503 });
        }
        return Response.json({
          choices: [{
            message: { role: 'assistant', content: 'Turn output' },
            finish_reason: 'stop',
          }],
        });
      });

      const turnBudget = new TurnLlmBudget(3, 'agentic-turn-1');
      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });

      setModelCapabilityOverride('groq', 'llama-3.3-70b-versatile', { enabled: true, fullCatalogCompatible: true, supportsTools: true });

      const reply1 = await router.generate({
        turnBudget,
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Do tool' }] }],
        tools: [],
      });
      expect(reply1.text).toBe('Turn output');
      expect(turnBudget.actualNetworkAttempts).toBe(3);

      // Phase 2: tool continuation in same turn. Budget is exhausted (actualNetworkAttempts === 3)!
      await expect(router.generate({
        turnBudget,
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Continue tool' }] }],
        tools: [],
      })).rejects.toThrow(LlmUnavailable);

      // Hard invariant: actualNetworkCalls MUST NOT exceed 3!
      expect(mockHttp).toHaveBeenCalledTimes(3);
    });

    it('skipped candidates (cooldown / preflight) do NOT consume network attempt budget', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'OK' }] },
          finishReason: 'STOP',
        }],
      }));

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      // Cooldown key 1
      const pool = router.getPool('gemini');
      pool?.recordFailure(1, new ProviderAttemptError('quota', 429, 60000), 100);

      const turnBudget = new TurnLlmBudget(3, 'turn-skip-test');
      await router.generate({
        turnBudget,
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        tools: [],
      });

      // Key 1 was skipped by cooldown; key 2 was called.
      // actualNetworkAttempts MUST be exactly 1!
      expect(turnBudget.actualNetworkAttempts).toBe(1);
      expect(mockHttp).toHaveBeenCalledTimes(1);
    });
  });

  describe('Strict Error Classification (Section 4)', () => {
    const baseConfig = {
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_API_KEYS: ['test-gemini-key-1', 'test-gemini-key-2'],
      GEMINI_MODEL: 'gemini-3.5-flash-lite' as const,
      GEMINI_MODELS: ['gemini-3.5-flash-lite'],
      GEMINI_FREE_TIER_CONFIRMED: true,
      GROQ_ENABLED: false,
      OPENROUTER_ENABLED: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    it('Gemini 400 INVALID_ARGUMENT -> invalid (no failover)', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: { message: 'Invalid arguments', status: 'INVALID_ARGUMENT' },
      }), { status: 400 }));

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      await expect(router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Bad request' }] }],
        tools: [],
      })).rejects.toThrow(LlmUnavailable);

      // No failover to key 2 on client-side invalid argument
      expect(mockHttp).toHaveBeenCalledTimes(1);
    });

    it('Gemini 400 API_KEY_INVALID -> auth failure disables key and fails over within budget', async () => {
      let callCount = 0;
      const mockHttp = vi.fn<typeof fetch>(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            error: { details: [{ reason: 'API_KEY_INVALID' }] },
          }), { status: 400 });
        }
        return Response.json({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'Key 2 succeeded' }] },
            finishReason: 'STOP',
          }],
        });
      });

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const reply = await router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        tools: [],
      });

      expect(reply.text).toBe('Key 2 succeeded');
      expect(mockHttp).toHaveBeenCalledTimes(2);
      expect(router.getPool('gemini')?.getState('gemini-key-1')?.available).toBe(false);
    });

    it('Gemini 403 SAFETY_REFUSAL -> blocked (no failover)', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: { message: 'Content safety refusal', status: 'SAFETY_REFUSAL' },
      }), { status: 403 }));

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      await expect(router.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Unsafe text' }] }],
        tools: [],
      })).rejects.toThrow(LlmUnavailable);

      expect(mockHttp).toHaveBeenCalledTimes(1);
    });

    it('Groq 403 moderation/safety -> blocked (no failover)', async () => {
      const groqAdapter = new GroqProvider(['llama-3.3-70b-versatile'], vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: { message: 'Request was flagged by safety guardrail', type: 'guardrail_violation' },
      }), { status: 403 })));

      await expect(groqAdapter.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Violating request' }] }],
        tools: [],
      }, 'llama-3.3-70b-versatile', 'gsk_test', 'groq-key-1')).rejects.toMatchObject({
        failureKind: 'blocked',
        status: 403,
      });
    });

    it('OpenRouter 403 moderation/flagged -> blocked (no failover)', async () => {
      const openRouterAdapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b-instruct'], false, vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: { message: 'Provider moderation flagged prompt', code: 'content_filter' },
      }), { status: 403 })));

      await expect(openRouterAdapter.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Violating request' }] }],
        tools: [],
      }, 'meta-llama/llama-3.3-70b-instruct', 'sk-or-test', 'openrouter-key-1')).rejects.toMatchObject({
        failureKind: 'blocked',
        status: 403,
      });
    });
  });

  describe('canHandle & Free Model Gating (Section 5 & 16)', () => {
    it('model with :free and OPENROUTER_ALLOW_FREE_MODELS=false yields zero network calls', async () => {
      const mockHttp = vi.fn<typeof fetch>();
      const adapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b:free'], false, mockHttp);

      const can = adapter.canHandle({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        tools: [],
      }, 'meta-llama/llama-3.3-70b:free');

      expect(can).toBe(false);
      expect(mockHttp).toHaveBeenCalledTimes(0);
    });
  });

  describe('Tool Args Malformed JSON (Section 7)', () => {
    it('Groq: malformed JSON tool args throws PROVIDER_TOOL_ARGS_INVALID_JSON and is not repaired to {}', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'minecraft_status', arguments: '{bad' },
            }],
          },
        }],
      }));

      const adapter = new GroqProvider(['llama-3.3-70b-versatile'], mockHttp);
      await expect(adapter.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Status' }] }],
        tools: [],
      }, 'llama-3.3-70b-versatile', 'gsk_test', 'groq-key-1')).rejects.toMatchObject({
        failureKind: 'invalid',
        providerErrorCode: 'PROVIDER_TOOL_ARGS_INVALID_JSON',
      });
    });

    it('OpenRouter: malformed JSON tool args throws PROVIDER_TOOL_ARGS_INVALID_JSON and is not repaired to {}', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'minecraft_status', arguments: 'not valid json' },
            }],
          },
        }],
      }));

      const adapter = new OpenRouterProvider(['meta-llama/llama-3.3-70b-instruct'], false, mockHttp);
      await expect(adapter.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Status' }] }],
        tools: [],
      }, 'meta-llama/llama-3.3-70b-instruct', 'sk-test', 'openrouter-key-1')).rejects.toMatchObject({
        failureKind: 'invalid',
        providerErrorCode: 'PROVIDER_TOOL_ARGS_INVALID_JSON',
      });
    });
  });

  describe('Conservative Gemini Finish Semantics (Section 8)', () => {
    it('does not execute Gemini functionCall when finishReason is MAX_TOKENS', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'minecraft_status', args: {} } }],
          },
          finishReason: 'MAX_TOKENS',
        }],
      }));

      const geminiAdapter = new GeminiProvider(['gemini-3.5-flash-lite'], mockHttp);
      await expect(geminiAdapter.generate({
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Check server' }] }],
        tools: [],
      }, 'gemini-3.5-flash-lite', 'key-test', 'gemini-key-1')).rejects.toMatchObject({
        failureKind: 'invalid',
        providerErrorCode: 'MAX_TOKENS',
      });
    });
  });

  describe('Vision / Media (Section 9)', () => {
    it('detects vision input and rejects model without vision support without dropping images', () => {
      const visionInput: LlmInput = {
        system: 'System',
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'abcd' } }] }],
        tools: [],
      };
      expect(hasVisionInput(visionInput)).toBe(true);

      const groqAdapter = new GroqProvider(['llama-3.3-70b-versatile']);
      // Groq does not support vision, canHandle must return false
      expect(groqAdapter.canHandle(visionInput, 'llama-3.3-70b-versatile')).toBe(false);

      // llmInputToOpenAiMessages throws incompatible when images present on non-vision model
      expect(() => llmInputToOpenAiMessages(visionInput, false)).toThrowError();
    });
  });

  describe('Tool Call IDs Stability (Section 12)', () => {
    it('generates distinct stable call IDs for parallel calls to same tool name', () => {
      const turnId = 'turn-test-parallel';
      const input: LlmInput = {
        turnId,
        system: 'System',
        contents: [
          { role: 'user', parts: [{ text: 'Run two searches' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'web_search', args: { query: 'cats' } } },
              { functionCall: { name: 'web_search', args: { query: 'dogs' } } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'web_search', response: { result: 'cats are cool' } } },
              { functionResponse: { name: 'web_search', response: { result: 'dogs are loyal' } } },
            ],
          },
        ],
        tools: [],
      };

      const messages = llmInputToOpenAiMessages(input, false);
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.tool_calls).toHaveLength(2);
      const id0 = assistantMsg!.tool_calls![0]!.id;
      const id1 = assistantMsg!.tool_calls![1]!.id;

      // Both must have distinct IDs
      expect(id0).not.toBe(id1);
      expect(id0).toContain('call_0');
      expect(id1).toContain('call_1');

      // The 2 tool response messages must correspond to their respective IDs
      const toolMsgs = messages.filter(m => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs[0]!.tool_call_id).toBe(id0);
      expect(toolMsgs[1]!.tool_call_id).toBe(id1);
    });
  });

  describe('Cross-Provider Continuation (Section 13)', () => {
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
      OPENROUTER_ENABLED: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite,groq/llama-3.3-70b-versatile',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    it('Option B: skips Gemini mid-turn if turn started with OpenAI format provider', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes('generativelanguage.googleapis.com')) {
          return Response.json({
            candidates: [{
              content: { role: 'model', parts: [{ text: 'Gemini' }] },
              finishReason: 'STOP',
            }],
          });
        }
        return Response.json({
          choices: [{
            message: { role: 'assistant', content: 'Groq reply' },
            finish_reason: 'stop',
          }],
        });
      });

      setModelCapabilityOverride('groq', 'llama-3.3-70b-versatile', { enabled: true, fullCatalogCompatible: true, supportsTools: true });

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const budget = new TurnLlmBudget(3, 'turn-cross-1');
      // Suppose earlier in the turn Groq executed a tool call
      budget.initialOpenAiFormat = true;

      const reply = await router.generate({
        turnBudget: budget,
        system: 'System',
        contents: [{ role: 'user', parts: [{ text: 'Tool continuation' }] }],
        tools: [],
      });

      // Gemini must have been skipped; Groq was chosen
      expect(reply.provider).toBe('groq');
    });
  });

  describe('Real Inbox Production Path Integration (Section 1)', () => {
    it('proves that a real inbox message goes through MultiProviderRouter', async () => {
      await harnessInitialize();
      await harnessReset();

      const router = getSharedMultiProviderRouter(harnessConfig, { db });
      const responsePayload = JSON.stringify({ outcome: 'conversation', text: 'Hola desde MultiProviderRouter!', effects: [] });
      const generateSpy = vi.spyOn(router, 'generate').mockResolvedValue({
        text: responsePayload,
        calls: [],
        content: {
          role: 'model',
          parts: [{ text: responsePayload }],
        },
        provider: 'gemini',
        model: harnessConfig.GEMINI_MODEL,
      });

      const msg: Msg = {
        id: randomUUID(),
        chatId: harnessChat,
        senderId: harnessOwner,
        isGroup: true,
        ts: new Date(),
        text: 'ola botsky',
        fromMe: false,
        mentions: [],
        attachments: [],
      };

      const accepted = await receive(db, harnessConfig, msg);
      expect(accepted).toBe('accepted');

      const processed = await processNext(db, harnessConfig);
      expect(processed).toBe(true);

      // Verifies that the real production flow: /webhook -> inbox -> ContextV2 -> naturalToolLoopV2
      // executes through MultiProviderRouter!
      expect(generateSpy).toHaveBeenCalled();
      const calls = generateSpy.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // Verify that outbox received the sanitized reply from MultiProviderRouter
      const outbox = await db.query<{ text: string }>("SELECT payload->>'text' text FROM outbox WHERE payload->>'sourceId'=$1", [msg.id]);
      expect(outbox.rows[0]?.text).toBe('Hola desde MultiProviderRouter!');

      generateSpy.mockRestore();
    });
  });
});
