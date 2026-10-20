import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  mergeAndDedupeApiKeys,
  readConfig,
  type Config,
} from '../src/config.js';
import {
  CURRENT_QUALIFICATION_VERSION,
  computeToolSchemaHash,
  loadQualificationManifest,
  saveQualificationManifest,
  getModelCapability,
  clearModelCapabilityOverrides,
  setModelCapabilityOverride,
  type QualifiedManifestEntry,
  type ToolDeclarationForHashing,
} from '../src/core/llm/capability-matrix.js';
import {
  MultiProviderRouter,
} from '../src/core/llm/index.js';
import { LlmUnavailable } from '../src/core/quota.js';

describe('FINAL MULTIPROVIDER CONFIG/LIFECYCLE HOTFIX', () => {
  const testDir = resolve(process.cwd(), 'tmp/test-hotfix-' + Date.now());

  beforeEach(() => {
    vi.restoreAllMocks();
    clearModelCapabilityOverrides();
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    clearModelCapabilityOverrides();
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  describe('5. Credential Merge + Dedupe', () => {
    it('exact prompt specification: API_KEY=A, API_KEYS=B,B,C,A produces exactly [A, B, C]', () => {
      const merged = mergeAndDedupeApiKeys('A', 'B,B,C,A');
      expect(merged).toEqual(['A', 'B', 'C']);
      expect(merged).toHaveLength(3);
    });

    it('handles singular only, plural only, and empty values gracefully', () => {
      expect(mergeAndDedupeApiKeys('A', '')).toEqual(['A']);
      expect(mergeAndDedupeApiKeys('', 'B, C')).toEqual(['B', 'C']);
      expect(mergeAndDedupeApiKeys(undefined, 'X, Y, X')).toEqual(['X', 'Y']);
      expect(mergeAndDedupeApiKeys('', '')).toEqual([]);
      expect(mergeAndDedupeApiKeys('  ', ' , , ')).toEqual([]);
    });

    it('handles plural passed as array with whitespace and duplicates', () => {
      const merged = mergeAndDedupeApiKeys(' key-1 ', ['key-2', ' key-1 ', 'key-3', 'key-2 ']);
      expect(merged).toEqual(['key-1', 'key-2', 'key-3']);
    });

    it('applies shared merge/dedupe in readConfig for Gemini, Groq, and OpenRouter', () => {
      const mockEnv = {
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        EVOLUTION_URL: 'http://mock',
        EVOLUTION_APIKEY: 'fixture',
        INSTANCE: 'test',
        WEBHOOK_SECRET: 'x'.repeat(32),
        OWNER_JIDS: '100@s.whatsapp.net',
        BOT_JIDS: '200@s.whatsapp.net',
        LAB_CHAT_ID: '300@g.us',
        TRANSPORT: 'mock' as const,
        GEMINI_API_KEY: 'key-g1',
        GEMINI_API_KEYS: 'key-g2, key-g2, key-g3, key-g1',
        GROQ_ENABLED: 'true',
        GROQ_API_KEY: 'gsk-1',
        GROQ_API_KEYS: 'gsk-2, gsk-1, gsk-3',
        OPENROUTER_ENABLED: 'true',
        OPENROUTER_API_KEY: 'or-1',
        OPENROUTER_API_KEYS: 'or-2, or-3, or-2',
      };

      const cfg = readConfig(mockEnv);
      expect(cfg.GEMINI_API_KEYS).toEqual(['key-g1', 'key-g2', 'key-g3']);
      expect(cfg.GROQ_API_KEYS).toEqual(['gsk-1', 'gsk-2', 'gsk-3']);
      expect(cfg.OPENROUTER_API_KEYS).toEqual(['or-1', 'or-2', 'or-3']);
    });

    it('rejects invalid credentials without leaking secret values in error messages', () => {
      expect(() => {
        readConfig({
          DATABASE_URL: 'postgresql://test:test@localhost/test',
          EVOLUTION_URL: 'http://mock',
          EVOLUTION_APIKEY: 'fixture',
          INSTANCE: 'test',
          WEBHOOK_SECRET: 'x'.repeat(32),
          OWNER_JIDS: '100@s.whatsapp.net',
          BOT_JIDS: '200@s.whatsapp.net',
          LAB_CHAT_ID: '300@g.us',
          GEMINI_API_KEY: 'bad key with spaces',
        });
      }).toThrow('Invalid configuration: GEMINI_API_KEYS / GEMINI_API_KEY');
    });
  });

  describe('2. Atomic Manifest Write & 1. Host Manifest Serialization', () => {
    it('writes manifest atomically via tmp file and rename, ensuring clean serialization', () => {
      const manifestPath = resolve(testDir, 'llm-qualified-models.json');
      const sampleCatalog: ToolDeclarationForHashing[] = [
        { name: 'core_ping', description: 'Ping tool', parametersJsonSchema: { type: 'object' } },
        { name: 'notes_create', description: 'Create note', parametersJsonSchema: { type: 'object', properties: { body: { type: 'string' } } } },
      ];
      const hash = computeToolSchemaHash(sampleCatalog);

      const entries: QualifiedManifestEntry[] = [
        {
          qualificationVersion: CURRENT_QUALIFICATION_VERSION,
          provider: 'gemini',
          model: 'gemini-3.5-flash-lite',
          toolCount: 2,
          toolSchemaHash: hash,
          qualifiedAt: new Date().toISOString(),
          status: 'FULL_CATALOG_SMOKE_COMPATIBLE',
          agentCompatible: true,
          fullCatalogCompatible: true,
          chatCompatible: true,
          latencyMs: 120,
        },
      ];

      saveQualificationManifest(entries, manifestPath);

      expect(existsSync(manifestPath)).toBe(true);
      const raw = readFileSync(manifestPath, 'utf8');
      const loaded = JSON.parse(raw);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].qualificationVersion).toBe(CURRENT_QUALIFICATION_VERSION);
      expect(loaded[0].toolSchemaHash).toBe(hash);
      expect(loaded[0].status).toBe('FULL_CATALOG_SMOKE_COMPATIBLE');

      // Verify no temporary files remain in testDir
      const files = existsSync(testDir) ? readdirSync(testDir) : [];
      expect(files.filter((f: string) => f.includes('.tmp.'))).toHaveLength(0);
    });
  });

  describe('3. Qualification Staleness & Tool Schema Hashing', () => {
    const catalogA: ToolDeclarationForHashing[] = [
      { name: 'core_ping', description: 'Ping tool', parametersJsonSchema: { type: 'object' } },
      { name: 'notes_create', description: 'Create note', parametersJsonSchema: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } } },
    ];

    // Canonicalization ensures key ordering differences produce the EXACT same hash
    const catalogAKeyOrderReversed: ToolDeclarationForHashing[] = [
      { name: 'notes_create', description: 'Create note', parametersJsonSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } } } },
      { name: 'core_ping', description: 'Ping tool', parametersJsonSchema: { type: 'object' } },
    ];

    const catalogBChangedSchema: ToolDeclarationForHashing[] = [
      { name: 'core_ping', description: 'Ping tool', parametersJsonSchema: { type: 'object' } },
      { name: 'notes_create', description: 'Create note modified', parametersJsonSchema: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } } },
    ];

    it('computes deterministic canonical hash invariant to tool ordering and key ordering', () => {
      const hashA1 = computeToolSchemaHash(catalogA);
      const hashA2 = computeToolSchemaHash(catalogAKeyOrderReversed);
      const hashB = computeToolSchemaHash(catalogBChangedSchema);

      expect(hashA1).toBe(hashA2);
      expect(hashA1).not.toBe(hashB);
    });

    it('deterministic test: catalog A trusted; catalog B modification rejects qualification at runtime', () => {
      const manifestPath = resolve(testDir, 'test-manifest.json');
      const hashA = computeToolSchemaHash(catalogA);

      const entries: QualifiedManifestEntry[] = [
        {
          qualificationVersion: CURRENT_QUALIFICATION_VERSION,
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          toolCount: catalogA.length,
          toolSchemaHash: hashA,
          qualifiedAt: new Date().toISOString(),
          status: 'FULL_CATALOG_SMOKE_COMPATIBLE',
          agentCompatible: true,
          fullCatalogCompatible: true,
          chatCompatible: true,
        },
      ];

      saveQualificationManifest(entries, manifestPath);

      // 1. With Catalog A: qualification matches -> model is agentCompatible
      loadQualificationManifest(manifestPath, catalogA);
      const capA = getModelCapability('groq', 'llama-3.3-70b-versatile');
      expect(capA.agentCompatible).toBe(true);
      expect(capA.fullCatalogCompatible).toBe(true);

      // 2. With Catalog B (schema changed): hash differs -> qualification rejected, UNQUALIFIED for agent use
      loadQualificationManifest(manifestPath, catalogBChangedSchema);
      const capB = getModelCapability('groq', 'llama-3.3-70b-versatile');
      expect(capB.agentCompatible).toBe(false);
      expect(capB.fullCatalogCompatible).toBe(false);
    });

    it.each(['version','count','fullCatalog'])('rejects mismatched qualification %s at runtime', mismatch => {
      const manifestPath = resolve(testDir, 'version-test.json');
      const hashA = computeToolSchemaHash(catalogA);

      const entries: QualifiedManifestEntry[] = [
        {
          qualificationVersion: mismatch === 'version' ? 'v0-deprecated' : CURRENT_QUALIFICATION_VERSION,
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          toolCount: catalogA.length + (mismatch === 'count' ? 1 : 0),
          toolSchemaHash: hashA,
          qualifiedAt: new Date().toISOString(),
          status: 'FULL_CATALOG_SMOKE_COMPATIBLE',
          agentCompatible: true,
          fullCatalogCompatible: mismatch !== 'fullCatalog',
          chatCompatible: true,
        },
      ];

      saveQualificationManifest(entries, manifestPath);
      loadQualificationManifest(manifestPath, catalogA);

      const cap = getModelCapability('groq', 'llama-3.3-70b-versatile');
      expect(cap.agentCompatible).toBe(false);
      expect(cap.fullCatalogCompatible).toBe(false);
    });
  });

  describe('6. Turn Budget Map Cleanup', () => {
    const baseConfig = {
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_API_KEYS: ['test-gemini-key-1'],
      GEMINI_MODEL: 'gemini-3.5-flash-lite' as const,
      GEMINI_MODELS: ['gemini-3.5-flash-lite'],
      GEMINI_FREE_TIER_CONFIRMED: true,
      GROQ_ENABLED: false,
      GROQ_API_KEYS: [],
      GROQ_MODELS: [],
      OPENROUTER_ENABLED: false,
      OPENROUTER_API_KEYS: [],
      OPENROUTER_MODELS: [],
      OPENROUTER_ALLOW_FREE_MODELS: false,
      LLM_ROUTE: 'gemini/gemini-3.5-flash-lite',
      LLM_MAX_PROVIDER_ATTEMPTS: 3,
    };

    it('100 completed turns -> retained budget count = 0', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Pong' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }));

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });

      for (let i = 0; i < 100; i++) {
        const turnId = `turn-100-${i}`;
        await router.runInTurn(turnId, async (budget) => {
          const res = await router.generate({
            turnId,
            turnBudget: budget,
            system: 'System',
            contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
            tools: [],
          });
          expect(res.text).toBe('Pong');
        });
      }

      expect(router.retainedBudgetCount).toBe(0);
    });

    it('turn throws provider error -> retained budget count = 0', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });

      const turnId = 'turn-error-1';
      await expect(
        router.runInTurn(turnId, async (budget) => {
          await router.generate({
            turnId,
            turnBudget: budget,
            system: 'System',
            contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
            tools: [],
          });
        })
      ).rejects.toThrow(LlmUnavailable);

      expect(router.retainedBudgetCount).toBe(0);
    });

    it('turn completes after tools -> retained budget count = 0 while preserving budget during turn', async () => {
      setModelCapabilityOverride('gemini','gemini-3.5-flash-lite',{agentCompatible:true,fullCatalogCompatible:true});
      let callStep = 0;
      const mockHttp = vi.fn<typeof fetch>(async () => {
        callStep++;
        if (callStep === 1) {
          // Tool call
          return Response.json({
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'core_ping', args: {} } }],
              },
              finishReason: 'STOP',
            }],
          });
        }
        // Final answer after tool
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'pong result' }],
            },
            finishReason: 'STOP',
          }],
        });
      });

      const router = new MultiProviderRouter(baseConfig as unknown as Config, { http: mockHttp });
      const turnId = 'turn-tools-multi-step';

      await router.runInTurn(turnId, async (budget) => {
        // Step 1
        const r1 = await router.generate({
          turnId,
          turnBudget: budget,
          system: 'System',
          contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
          tools: [{ name: 'core_ping', description: 'Ping', parametersJsonSchema: { type: 'object' } }],
        });
        expect(r1.calls).toHaveLength(1);
        expect(budget.actualNetworkAttempts).toBe(1);

        // Budget is active and retained
        expect(router.retainedBudgetCount).toBe(1);

        // Step 2
        const r2 = await router.generate({
          turnId,
          turnBudget: budget,
          system: 'System',
          contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
          tools: [],
        });
        expect(r2.text).toBe('pong result');
        expect(budget.actualNetworkAttempts).toBe(2);
      });

      // After turn completes, budget is cleaned up
      expect(router.retainedBudgetCount).toBe(0);
    });
  });

  describe('7. Provider Telemetry', () => {
    it('exposes safe structured telemetry with opaque credentialId and no secrets', async () => {
      const mockHttp = vi.fn<typeof fetch>(async () => Response.json({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Safe reply' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }));

      const secretKey = 'super-secret-key-never-log-12345';
      const configWithSecret = {
        GEMINI_API_KEY: secretKey,
        GEMINI_API_KEYS: [secretKey],
        GEMINI_MODEL: 'gemini-3.5-flash-lite' as const,
        GEMINI_MODELS: ['gemini-3.5-flash-lite'],
        GEMINI_FREE_TIER_CONFIRMED: true,
        GROQ_ENABLED: false,
        GROQ_API_KEYS: [],
        GROQ_MODELS: [],
        OPENROUTER_ENABLED: false,
        OPENROUTER_API_KEYS: [],
        OPENROUTER_MODELS: [],
        OPENROUTER_ALLOW_FREE_MODELS: false,
        LLM_ROUTE: 'gemini/gemini-3.5-flash-lite',
        LLM_MAX_PROVIDER_ATTEMPTS: 3,
      };

      const router = new MultiProviderRouter(configWithSecret as unknown as Config, { http: mockHttp });
      const turnId = 'turn-telemetry-safe-1';

      const reply = await router.runInTurn(turnId, async (budget) => {
        return router.generate({
          turnId,
          turnBudget: budget,
          system: 'System',
          contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
          tools: [],
        });
      });

      expect(reply.text).toBe('Safe reply');
      expect(reply.provider).toBe('gemini');
      expect(reply.credentialId).toBe('gemini-key-1'); // Opaque ID
      expect(reply.credentialId).not.toContain(secretKey);
      expect(reply.actualNetworkAttempts).toBe(1);
    });
  });

  describe('4. Compose / Config Parsing', () => {
    it('parses config correctly with Groq and OpenRouter disabled by default', () => {
      const cfg = readConfig({
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        EVOLUTION_URL: 'http://mock',
        EVOLUTION_APIKEY: 'fixture',
        INSTANCE: 'test',
        WEBHOOK_SECRET: 'x'.repeat(32),
        OWNER_JIDS: '100@s.whatsapp.net',
        BOT_JIDS: '200@s.whatsapp.net',
        LAB_CHAT_ID: '300@g.us',
        TRANSPORT: 'mock',
        GEMINI_API_KEY: 'test-gemini-key',
      });

      expect(cfg.GROQ_ENABLED).toBe(false);
      expect(cfg.OPENROUTER_ENABLED).toBe(false);
      expect(cfg.GEMINI_API_KEYS.length).toBe(1);
      expect(cfg.QUALIFICATION_MANIFEST_PATH).toBe('var/llm-qualified-models.json');
    });
  });
});
