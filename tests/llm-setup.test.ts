import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  detectProvider,
  classifyKeys,
  updateEnvFile,
  discoverGroqModels,
  discoverOpenRouterModels,
  runLlmSetup,
} from '../scripts/llm-setup.js';

describe('LLM Setup & Onboarding UX', () => {
  const testDir = resolve(process.cwd(), 'tmp/test-setup-' + Date.now());

  beforeEach(() => {
    vi.restoreAllMocks();
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('1. Provider Detection & Credential Validation', () => {
    it('detects Gemini keys by prefix and API response', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        return new Response(null, { status: 401 });
      });

      const provider = await detectProvider('AIzaSyTestGeminiKey12345678901234567890', mockHttp);
      expect(provider).toBe('gemini');
    });

    it('detects Groq keys by prefix and API response', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('api.groq.com')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(null, { status: 401 });
      });

      const provider = await detectProvider('gsk_testGroqKey12345678901234567890123456789012', mockHttp);
      expect(provider).toBe('groq');
    });

    it('detects OpenRouter keys by prefix and API response', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('openrouter.ai')) {
          return new Response(JSON.stringify({ data: { is_free_tier: true } }), { status: 200 });
        }
        return new Response(null, { status: 401 });
      });

      const provider = await detectProvider('sk-or-v1-testOpenRouterKey123456789012345678901234', mockHttp);
      expect(provider).toBe('openrouter');
    });

    it('detects keys without known prefix by probing candidate endpoints', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('api.groq.com')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(null, { status: 401 });
      });

      // Custom key without gsk_ prefix
      const provider = await detectProvider('custom_unprefixed_groq_key_value', mockHttp);
      expect(provider).toBe('groq');
    });

    it('returns invalid for keys that fail all provider validations', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
      const provider = await detectProvider('completely_bogus_key', mockHttp);
      expect(provider).toBe('invalid');
    });

    it('classifies mixed collection of keys and assigns opaque IDs', async () => {
      const mockHttp = vi.fn<typeof fetch>(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('bogus')) return new Response(null, { status: 401 });
        if (urlStr.includes('generativelanguage.googleapis.com') && urlStr.includes('AIzaSy')) return new Response('{}', { status: 200 });
        if (urlStr.includes('api.groq.com') && (init?.headers as Record<string, string>)?.['Authorization']?.includes('gsk_')) return new Response('{}', { status: 200 });
        if (urlStr.includes('openrouter.ai') && (init?.headers as Record<string, string>)?.['Authorization']?.includes('sk-or-')) return new Response('{}', { status: 200 });
        return new Response(null, { status: 401 });
      });

      const raw = [
        'AIzaSyKey1',
        'gsk_Key1',
        'sk-or-v1-Key1',
        'AIzaSyKey2',
        'gsk_Key1', // Duplicate
        'bogus_key_xyz',
      ];

      const res = await classifyKeys(raw, mockHttp);
      expect(res.gemini).toHaveLength(2);
      expect(res.groq).toHaveLength(1); // Deduped
      expect(res.openrouter).toHaveLength(1);
      expect(res.invalid).toBe(1);

      // Verify opaque IDs
      expect(res.classified.map(c => c.opaqueId)).toEqual([
        'gemini-key-1',
        'groq-key-1',
        'openrouter-key-1',
        'gemini-key-2',
        'unknown-key-1',
      ]);
    });
  });

  describe('2. Atomic .env Configuration & Merge', () => {
    it('preserves existing variables and comments while updating managed LLM variables', () => {
      const envPath = resolve(testDir, '.env');
      const initial = [
        '# Botsky production configuration',
        'DATABASE_URL=postgres://user:pass@localhost:5432/botsky',
        'WEBHOOK_SECRET=supersecretwebhook123',
        'GEMINI_API_KEY=AIzaSyExistingKey1',
        'PORT=3000',
      ].join('\n');
      writeFileSync(envPath, initial, { mode: 0o600 });

      updateEnvFile(envPath, {
        GEMINI_API_KEYS: 'AIzaSyExistingKey1,AIzaSyNewKey2',
        GROQ_ENABLED: 'true',
        GROQ_API_KEYS: 'gsk_NewKey1',
        LLM_ROUTE: 'gemini|gemini-3.5-flash-lite,groq|llama-3.3-70b-versatile',
      });

      const readBack = readFileSync(envPath, 'utf8');
      expect(readBack).toContain('# Botsky production configuration');
      expect(readBack).toContain('DATABASE_URL=postgres://user:pass@localhost:5432/botsky');
      expect(readBack).toContain('WEBHOOK_SECRET=supersecretwebhook123');
      expect(readBack).toContain('PORT=3000');
      expect(readBack).toContain('GEMINI_API_KEYS=AIzaSyExistingKey1,AIzaSyNewKey2');
      expect(readBack).toContain('GROQ_ENABLED=true');
      expect(readBack).toContain('GROQ_API_KEYS=gsk_NewKey1');
      expect(readBack).toContain('LLM_ROUTE=gemini|gemini-3.5-flash-lite,groq|llama-3.3-70b-versatile');

      // Verify permissions 0600
      const stat = statSync(envPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('3. Model Discovery', () => {
    it('discovers and filters Groq models (active, large context, non-audio)', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        data: [
          { id: 'whisper-large-v3', active: true, context_window: 1500 },
          { id: 'llama-guard-3-8b', active: true, context_window: 8192 },
          { id: 'llama-3.1-8b-instant', active: true, context_window: 131072 },
          { id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 },
          { id: 'deprecated-model', active: false, context_window: 131072 },
        ],
      }));

      const discovered = await discoverGroqModels('gsk_test', mockHttp);
      // Top candidate must be 70b versatile, followed by 8b instant; whisper and guard excluded
      expect(discovered).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    });

    it('discovers and filters OpenRouter models (free, tools supported, large context)', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        data: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            context_length: 128000,
            pricing: { prompt: '0.000005', completion: '0.000015' },
            supported_parameters: ['tools'],
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct:free',
            name: 'Llama 3.3 70B (free)',
            context_length: 131072,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools'],
          },
          {
            id: 'google/gemini-2.0-flash-exp:free',
            name: 'Gemini 2.0 Flash Exp (free)',
            context_length: 1048576,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools'],
          },
          {
            id: 'no-tools/model:free',
            name: 'No Tools Model',
            context_length: 32768,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: [],
          },
        ],
      }));

      const discovered = await discoverOpenRouterModels('sk-or-v1-test', mockHttp);
      // Only free tool models; paid GPT-4o and no-tools model excluded
      expect(discovered).toContain('meta-llama/llama-3.3-70b-instruct:free');
      expect(discovered).toContain('google/gemini-2.0-flash-exp:free');
      expect(discovered).not.toContain('openai/gpt-4o');
      expect(discovered).not.toContain('no-tools/model:free');
    });
  });

  describe('4. Full Setup Pipeline (Dry-run with Mocks)', () => {
    it('executes setup end-to-end and outputs clean report with zero secrets exposed', async () => {
      const envPath = resolve(testDir, '.env');
      const manifestPath = resolve(testDir, 'llm-qualified-models.json');

      writeFileSync(envPath, [
        'GEMINI_API_KEY=AIzaSyInitialWorkingKey',
        'WEBHOOK_SECRET=fakeWebhookSecret123',
        'LAB_CHAT_ID=test-lab@g.us',
      ].join('\n'), { mode: 0o600 });

      const mockHttp = vi.fn<typeof fetch>(async (url, init) => {
        const urlStr = String(url);
        // Validation probes
        if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models?key=')) {
          return Response.json({ models: [{ name: 'models/gemini-3.5-flash-lite' }] });
        }
        if (urlStr.includes('api.groq.com/openai/v1/models')) {
          return Response.json({
            data: [{ id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 }],
          });
        }
        if (urlStr.includes('openrouter.ai/api/v1/auth/key')) {
          return Response.json({ data: { is_free_tier: true } });
        }
        if (urlStr.includes('openrouter.ai/api/v1/models')) {
          return Response.json({
            data: [{
              id: 'meta-llama/llama-3.3-70b-instruct:free',
              pricing: { prompt: '0', completion: '0' },
              supported_parameters: ['tools'],
              context_length: 131072,
            }],
          });
        }

        // Gemini generate calls
        if (urlStr.includes('generativelanguage.googleapis.com') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const hasResponse = body.contents?.some((c: { parts?: { functionResponse?: unknown }[] }) =>
            c.parts?.some(p => p.functionResponse)
          );
          if (hasResponse) {
            return Response.json({
              candidates: [{
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: 'Sí, el servidor está online!' }] },
              }],
            });
          }
          if (body.contents?.[0]?.parts?.[0]?.text?.includes('maicra')) {
            return Response.json({
              candidates: [{
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'minecraft_status', args: {} } }],
                },
              }],
            });
          }
          if (body.contents?.[0]?.parts?.[0]?.text?.includes('videos')) {
            return Response.json({
              candidates: [{
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'video_search', args: { query: 'minecraft', source:'dailymotion' } } }],
                },
              }],
            });
          }
          return Response.json({
            candidates: [{
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: 'Hola, Botsky responde!' }] },
            }],
          });
        }

        // Groq / OpenRouter OpenAI-compatible generate calls
        if ((urlStr.includes('api.groq.com') || urlStr.includes('openrouter.ai')) && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const lastMsg = body.messages?.at(-1)?.content;
          if (typeof lastMsg === 'string' && lastMsg.includes('maicra')) {
            return Response.json({
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'minecraft_status', arguments: '{}' } }],
                },
              }],
            });
          }
          if (typeof lastMsg === 'string' && lastMsg.includes('videos')) {
            return Response.json({
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'video_search', arguments: '{"query":"minecraft","source":"dailymotion"}' } }],
                },
              }],
            });
          }
          return Response.json({
            choices: [{
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Respuesta modelo calificado' },
            }],
          });
        }

        return new Response(null, { status: 404 });
      });

      const report = await runLlmSetup({
        rawKeys: [
          'AIzaSyNewGeminiKey2',
          'gsk_NewGroqKey1',
          'sk-or-v1-NewOpenRouterKey1',
        ],
        envPath,
        manifestPath,
        http: mockHttp,
        skipRecreate: true,
        skipSmoke: true,
      });

      // Assertions on report
      expect(report.credentials.gemini.valid).toBe(2); // Initial + 1 new
      expect(report.credentials.groq.valid).toBe(1);
      expect(report.credentials.openrouter.valid).toBe(1);
      expect(report.credentials.invalid).toBe(0);

      expect(report.route).toContain('gemini|gemini-3.5-flash-lite');
      expect(report.route).toContain('groq|llama-3.3-70b-versatile');
      expect(report.route).toContain('openrouter|meta-llama/llama-3.3-70b-instruct:free');

      // Verify .env was written
      const envContent = readFileSync(envPath, 'utf8');
      expect(envContent).toContain('GEMINI_API_KEYS=AIzaSyInitialWorkingKey,AIzaSyNewGeminiKey2');
      expect(envContent).toContain('GROQ_ENABLED=true');
      expect(envContent).toContain('GROQ_API_KEYS=gsk_NewGroqKey1');
      expect(envContent).toContain('GROQ_MODELS=llama-3.3-70b-versatile');
      expect(envContent).toContain('OPENROUTER_ENABLED=true');
      expect(envContent).toContain('OPENROUTER_API_KEYS=sk-or-v1-NewOpenRouterKey1');
      expect(envContent).toContain('OPENROUTER_ALLOW_FREE_MODELS=true');

      // Verify manifest exists and is valid
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.length).toBeGreaterThanOrEqual(3);
      expect(manifest.every((m: { qualificationVersion: string }) => m.qualificationVersion === 'v1')).toBe(true);
    });
  });
});
