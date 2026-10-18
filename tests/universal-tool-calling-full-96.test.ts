import { describe, it, expect } from 'vitest';
import { readConfig } from '../src/config.js';
import { product } from '../config/product.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2, registryV2Declarations, modelDeclaration } from '../src/core/tool-registry-v2.js';
import { selectToolExposure, ToolExposureTurn, type ToolExposureInput } from '../src/core/tool-exposure.js';
import { capabilityManifestV2, currentFunctionProtocolV2, capabilityBehaviorV2ForMode, capabilityBehaviorV2 } from '../src/core/capability-manifest-v2.js';
import { capabilityContextV2 } from '../src/core/capability-truth-v2.js';
import { naturalRouterSystemV2 } from '../src/core/router-v2.js';
import { naturalToolLoopV2, type RouterMetricsV2 } from '../src/core/tool-loop-v2.js';
import type { Llm, LlmInput } from '../src/core/llm.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { TurnContextV2 } from '../src/core/context-v2-types.js';
import { SafeRefs } from '../src/core/safe-refs.js';

const legacy = createRegistry();
const catalog = createToolRegistryV2(legacy);
const allModules = [...new Set(catalog.map(t => t.requiredModule))];

describe('FULL-96: Declarations & Catalog Integrity (R1)', () => {
  it('generates exactly 96 public tools from Registry native declarations', () => {
    const decls = registryV2Declarations(catalog);
    expect(decls).toHaveLength(96);
  });

  it('strictly excludes internal tools (0 internal tools leaked)', () => {
    const decls = registryV2Declarations(catalog);
    const names = decls.map(d => d.name);
    expect(names).not.toContain('bulk_confirm');
    expect(names).not.toContain('bulk.confirm');
    expect(names).not.toContain('school_schedule_commit');
    expect(names).not.toContain('school.schedule_commit');

    const internalTools = catalog.filter(t => t.exposure === 'internal');
    expect(internalTools).toHaveLength(2);
    for (const t of internalTools) {
      expect(() => modelDeclaration(t)).toThrow('Internal tool');
    }
  });

  it('guarantees 0 duplicates across all declarations', () => {
    const decls = registryV2Declarations(catalog);
    const names = decls.map(d => d.name);
    expect(new Set(names).size).toBe(96);
  });

  it('measures schema payload and identifies top 5 largest schemas', () => {
    const decls = registryV2Declarations(catalog);
    const payload = JSON.stringify(decls);
    const byteLength = Buffer.byteLength(payload, 'utf8');

    // Schema payload should be around ~49k bytes
    expect(byteLength).toBeGreaterThan(45_000);
    expect(byteLength).toBeLessThan(60_000);

    const sizes = decls.map(d => ({ name: d.name, size: JSON.stringify(d).length }));
    sizes.sort((a, b) => b.size - a.size);
    const top5 = sizes.slice(0, 5);

    expect(new Set(top5.map(s => s.name))).toEqual(new Set([
      'reminders_create',
      'reminders_edit',
      'school_task_create',
      'school_task_edit',
      'media_process',
    ]));
  });
});

describe('FULL-96: Tool Exposure & Meta-Tools (R1, R4)', () => {
  const baseInput: ToolExposureInput = {
    actorRole: 'owner',
    chatType: 'group',
    enabledModules: allModules,
    toolCallingMode: 'full_96',
  };

  it('exposes all 96 public tools from turn 1 in full_96 mode', () => {
    const exposure = selectToolExposure(catalog, baseInput);
    // 96 business tools + 1 meta-tool (core.load_artifact_context)
    expect(exposure.toolNames).toHaveLength(97);
    expect(exposure.schemas).toHaveLength(97);

    // Verify key domain tools are directly present on turn 1
    expect(exposure.toolNames).toContain('minecraft.status');
    expect(exposure.toolNames).toContain('minecraft.restart');
    expect(exposure.toolNames).toContain('school.tasks');
    expect(exposure.toolNames).toContain('school.schedule');
    expect(exposure.toolNames).toContain('media.process');
    expect(exposure.toolNames).toContain('reminders.create');
    expect(exposure.toolNames).toContain('xp.balance');
    expect(exposure.toolNames).toContain('notes.create');
  });

  it('strictly excludes core.load_capability in full_96 mode', () => {
    const exposure = selectToolExposure(catalog, baseInput);
    expect(exposure.toolNames).not.toContain('core.load_capability');
    expect(exposure.toolNames).not.toContain('core_load_capability');
    expect(exposure.schemas.some(s => s.name === 'core_load_capability')).toBe(false);
  });

  it('exposes core.load_artifact_context and conditionally session meta-tools', () => {
    // Normal turn: only load_artifact_context
    const normal = selectToolExposure(catalog, baseInput);
    expect(normal.toolNames).toContain('core.load_artifact_context');
    expect(normal.toolNames).not.toContain('core.session_confirm');
    expect(normal.toolNames).not.toContain('core.session_cancel');

    // Confirm session active
    const confirm = selectToolExposure(catalog, {
      ...baseInput,
      activeSession: { domain: 'messaging', kind: 'confirm', pendingTool: 'bulk.nuclear' },
    });
    expect(confirm.toolNames).toContain('core.session_confirm');
    expect(confirm.toolNames).toContain('core.session_cancel');
    expect(confirm.schemas.some(s => s.name === 'core_session_confirm')).toBe(true);
    expect(confirm.schemas.some(s => s.name === 'core_session_cancel')).toBe(true);

    // Clarify session active
    const clarify = selectToolExposure(catalog, {
      ...baseInput,
      activeSession: { domain: 'productivity', kind: 'clarify', pendingTool: 'reminders.create' },
    });
    expect(clarify.toolNames).not.toContain('core.session_confirm');
    expect(clarify.toolNames).toContain('core.session_cancel');
  });

  it('rejects loadCapability in full_96 mode without changing exposure', () => {
    const turn = new ToolExposureTurn(catalog, baseInput);
    const beforeCount = turn.exposure.toolNames.length;
    const result = turn.loadCapability({ domain: 'minecraft' });
    expect(result.status).toBe('not_relevant_or_allowed');
    expect(turn.exposure.toolNames.length).toBe(beforeCount);
  });

  it('does not drop tools when fitSchemaBudget is called with llmMaxFullRequestChars budget', () => {
    const turn = new ToolExposureTurn(catalog, baseInput);
    const countBefore = turn.exposure.schemas.length;
    // With 128k - 20k overhead, ~108k remains, easily fitting ~49k schemas
    turn.fitSchemaBudget(product.llmMaxFullRequestChars - 20_000);
    expect(turn.exposure.schemas.length).toBe(countBefore);
  });
});

describe('FULL-96: Manifest & Prompt Protocol Invariants (R1, R4)', () => {
  const dummyCtx = {
    actor: { id: '100@s.whatsapp.net', role: 'owner' as const },
    chat: { id: '300@g.us', isGroup: true, enabled: true, settings: {} },
    config: readConfig({
      DATABASE_URL: 'postgresql://botsky:pwd@botsky-db:5432/botsky',
      TRANSPORT: 'evolution',
      EVOLUTION_URL: 'http://localhost:8080',
      EVOLUTION_APIKEY: 'apikey',
      INSTANCE: 'instance',
      WEBHOOK_SECRET: 'x'.repeat(32),
      OWNER_JIDS: '100@s.whatsapp.net',
      BOT_JIDS: '200@s.whatsapp.net',
      LAB_CHAT_ID: '300@g.us',
      GEMINI_API_KEY: 'test-key',
      TOOL_CALLING_MODE: 'full_96',
    }),
  };

  it('omits core.load_capability in capabilityManifestV2 under full_96 mode', () => {
    const manifest = capabilityManifestV2(catalog, dummyCtx, 'full_96');
    expect(manifest).not.toContain('core.load_capability');
    expect(manifest).not.toContain('core_load_capability');
    expect(manifest).toContain('Formato: capacidad: significado entrada→salida;estado. ∅=sin entrada; g=solo grupo.');

    // Dynamic mode retains it
    const dynamicManifest = capabilityManifestV2(catalog, dummyCtx, 'dynamic');
    expect(dynamicManifest).toContain('[dominio]: core.load_capability carga schemas faltantes.');
  });

  it('omits core_load_capability in currentFunctionProtocolV2 under full_96 mode', () => {
    const protocol = currentFunctionProtocolV2(['tool_a', 'tool_b'], 'full_96');
    expect(protocol).not.toContain('core_load_capability');
    expect(protocol).not.toContain('core.load_capability');

    // Dynamic mode retains it
    const dynamicProtocol = currentFunctionProtocolV2(['tool_a'], 'dynamic');
    expect(dynamicProtocol).toContain('core_load_capability FIRST');
  });

  it('omits core_load_capability in capabilityBehaviorV2ForMode under full_96 mode', () => {
    const behavior = capabilityBehaviorV2ForMode('full_96');
    expect(behavior).not.toContain('core_load_capability');
    expect(behavior).not.toContain('core.load_capability');
    expect(behavior).toContain('Usa exclusivamente los argumentos/operaciones del schema de la herramienta invocada.');

    // Default dynamic behavior retains it
    expect(capabilityBehaviorV2).toContain('DEBES llamar core_load_capability');
  });

  it('omits core_load_capability in capabilityContextV2 under full_96 mode', () => {
    const exposure = selectToolExposure(catalog, { actorRole: 'owner', chatType: 'group', enabledModules: allModules, toolCallingMode: 'full_96' });
    const text = capabilityContextV2(exposure, 'full_96');
    expect(text).not.toContain('core_load_capability');
    expect(text).toContain('todas las herramientas públicas disponibles');

    const dynamicText = capabilityContextV2(exposure, 'dynamic');
    expect(dynamicText).toContain('core_load_capability carga el dominio que falte');
  });

  it('naturalRouterSystemV2 produces clean prompt without core_load_capability in full_96 mode', () => {
    const turn = new ToolExposureTurn(catalog, { actorRole: 'owner', chatType: 'group', enabledModules: allModules, toolCallingMode: 'full_96' });
    const system = naturalRouterSystemV2(turn, 'full_96');
    expect(system).not.toContain('core_load_capability');
    expect(system).not.toContain('core.load_capability');
    expect(system).toContain('Usa schemas expuestos según CAPABILITY_MANIFEST.');
  });
});

describe('FULL-96: Dual-Mode Feature Flag & Immediate Rollback (R5)', () => {
  it('defaults to dynamic mode in config schema (fail-safe invariant)', () => {
    const config = readConfig({
      DATABASE_URL: 'postgresql://botsky:pwd@botsky-db:5432/botsky',
      TRANSPORT: 'evolution',
      EVOLUTION_URL: 'http://localhost:8080',
      EVOLUTION_APIKEY: 'apikey',
      INSTANCE: 'instance',
      WEBHOOK_SECRET: 'x'.repeat(32),
      OWNER_JIDS: '100@s.whatsapp.net',
      BOT_JIDS: '200@s.whatsapp.net',
      LAB_CHAT_ID: '300@g.us',
      GEMINI_API_KEY: 'test-key',
    });
    expect(config.TOOL_CALLING_MODE).toBe('dynamic');
  });

  it('immediately restores baseline dynamic behavior when switched to dynamic', () => {
    const dynamicTurn = new ToolExposureTurn(catalog, {
      actorRole: 'owner',
      chatType: 'group',
      enabledModules: allModules,
      toolCallingMode: 'dynamic',
    });
    // Baseline: only alwaysOn tools (7) + meta tools (2) = 9
    expect(dynamicTurn.exposure.toolNames).toHaveLength(9);
    expect(dynamicTurn.exposure.toolNames).toContain('core.load_capability');
    expect(dynamicTurn.exposure.schemas.length).toBeLessThanOrEqual(20);

    // Expansion functions in dynamic mode
    const expansion = dynamicTurn.loadCapability({ domain: 'minecraft' });
    expect(expansion.status).toBe('ok');
    expect(dynamicTurn.exposure.toolNames).toContain('minecraft.status');
  });

  it('applies product.llmMaxFullRequestChars (128_000) guard for full_96', () => {
    expect(product.llmMaxFullRequestChars).toBe(128_000);
    expect(product.llmMaxRequestChars).toBe(32_000);
  });
});

describe('FULL-96: Tool Loop Native Protocol & Security (R2, R3, R4)', () => {
  function makeMockCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
    const config = readConfig({
      DATABASE_URL: 'postgresql://botsky:pwd@botsky-db:5432/botsky',
      TRANSPORT: 'mock',
      EVOLUTION_URL: 'http://localhost:8080',
      EVOLUTION_APIKEY: 'apikey',
      INSTANCE: 'instance',
      WEBHOOK_SECRET: 'x'.repeat(32),
      OWNER_JIDS: '100@s.whatsapp.net',
      BOT_JIDS: '200@s.whatsapp.net',
      LAB_CHAT_ID: '300@g.us',
      GEMINI_API_KEY: 'test-key',
      TOOL_CALLING_MODE: 'full_96',
      ROUTER_MODE: 'v1_1',
    });
    return {
      c: {
        query: async () => ({ rows: [], rowCount: 0 }),
      } as unknown as ToolCtx['c'],
      db: {} as unknown as ToolCtx['db'],
      config,
      now: new Date('2026-10-18T12:00:00Z'),
      turnId: '11111111-1111-1111-1111-111111111111',
      msg: {
        id: '22222222-2222-2222-2222-222222222222',
        chatId: '300@g.us',
        senderId: '100@s.whatsapp.net',
        isGroup: true,
        ts: new Date('2026-10-18T12:00:00Z'),
        text: 'test',
        mentions: [],
        fromMe: false,
        attachments: [],
      },
      actor: { id: '100@s.whatsapp.net', role: 'owner' },
      chat: { id: '300@g.us', isGroup: true, enabled: true, settings: {} },
      search: async () => '',
      ...overrides,
    };
  }

  function makeMockTurnContext(ctx: ToolCtx): TurnContextV2 {
    return {
      runtime: {
        turnId: ctx.turnId!,
        sourceMessageId: ctx.msg.id,
        now: ctx.now,
        actor: ctx.actor,
        chat: ctx.chat,
        role: ctx.actor.role,
        timezone: ctx.config.TZ_DEFAULT,
        enabledModules: allModules,
        routerMode: ctx.config.ROUTER_MODE,
      },
      envelope: {
        SYSTEM_RULES: ['rules'],
        CAPABILITY_MANIFEST: 'manifest',
        ARTIFACT_STATE: { CURRENT: [], REPLIED: null, RECENT: [], A_LAST: null },
        REFERENCE_DATA: {
          nowLocal: '2026-10-18T12:00:00',
          actor: { ref: 'SELF', displayName: 'Owner', role: 'owner' },
          chat: { type: 'group', availableModules: allModules },
          recentArtifacts: [],
          notes: [],
          reminders: [],
          school: [],
          members: [],
          personalMemoryAvailable: false,
          personalMemories: [],
          recentResults: [],
          recentEvents: [],
          recentDialogue: [],
        },
        CURRENT_USER_TURN: { userText: ctx.msg.text, mentions: [] },
      },
      safeRefMap: new SafeRefs([]),
      metrics: {
        contextChars: 100,
        estimatedTokens: 25,
        artifactCount: 0,
        selectedArtifactKind: null,
        sessionKind: null,
        sessionDecision: 'not_consumed',
        activeEntityKinds: [],
      },
    };
  }

  it('returns direct text without function calls on conversational turn (R2)', async () => {
    const ctx = makeMockCtx();
    const context = makeMockTurnContext(ctx);
    const exposure = new ToolExposureTurn(catalog, {
      actorRole: 'owner',
      chatType: 'group',
      enabledModules: allModules,
      toolCallingMode: 'full_96',
    });
    const metrics: RouterMetricsV2 = {
      callsPerTurn: 0, inputTokens: 0, outputTokens: 0, toolCount: 0,
      capabilityExpansion: 0, synthesisUsed: false, mutationRetry: 0, routerLatency: 0, backendFieldAttempts: 0,
    };

    const mockLlm: Llm = {
      generate: async () => ({
        text: '¡Hola! Todo en orden por acá.',
        calls: [],
        content: {
          role: 'model',
          parts: [{ text: JSON.stringify({ outcome: 'conversation', text: '¡Hola! Todo en orden por acá.', effects: [] }) }],
        },
      }),
    };

    const reply = await naturalToolLoopV2(
      ctx, mockLlm, catalog, context, exposure, 'system', 'Hola botsky', [], metrics,
    );

    expect(reply).toBe('¡Hola! Todo en orden por acá.');
    expect(metrics.toolCount).toBe(0);
    expect(metrics.callsPerTurn).toBe(1);
  });

  it('returns conversational refusal without fake function calls on unsupported request (R2)', async () => {
    const ctx = makeMockCtx();
    const context = makeMockTurnContext(ctx);
    const exposure = new ToolExposureTurn(catalog, {
      actorRole: 'owner',
      chatType: 'group',
      enabledModules: allModules,
      toolCallingMode: 'full_96',
    });
    const metrics: RouterMetricsV2 = {
      callsPerTurn: 0, inputTokens: 0, outputTokens: 0, toolCount: 0,
      capabilityExpansion: 0, synthesisUsed: false, mutationRetry: 0, routerLatency: 0, backendFieldAttempts: 0,
    };

    const mockLlm: Llm = {
      generate: async () => ({
        text: 'No puedo convertir documentos a Word.',
        calls: [],
        content: {
          role: 'model',
          parts: [{ text: JSON.stringify({ outcome: 'unavailable', capability: { toolName: 'media.process', outputFormat: 'docx' }, text: 'No puedo convertir documentos a Word (.docx).', effects: [] }) }],
        },
      }),
    };

    const reply = await naturalToolLoopV2(
      ctx, mockLlm, catalog, context, exposure, 'system', 'convierte a word', [], metrics,
    );

    expect(reply).toContain('No puedo convertir documentos a Word');
    expect(metrics.toolCount).toBe(0);
  });

  it('rejects core.load_capability call under full_96 mode with DENIED (R1, R4)', async () => {
    const ctx = makeMockCtx();
    const context = makeMockTurnContext(ctx);
    const exposure = new ToolExposureTurn(catalog, {
      actorRole: 'owner',
      chatType: 'group',
      enabledModules: allModules,
      toolCallingMode: 'full_96',
    });
    const metrics: RouterMetricsV2 = {
      callsPerTurn: 0, inputTokens: 0, outputTokens: 0, toolCount: 0,
      capabilityExpansion: 0, synthesisUsed: false, mutationRetry: 0, routerLatency: 0, backendFieldAttempts: 0,
    };

    let secondTurnToolNames: string[] = [];
    const mockLlm: Llm = {
      generate: async (req: LlmInput) => {
        if (metrics.callsPerTurn === 1) {
          // Gemini tries to call core_load_capability in full_96
          return {
            text: '',
            calls: [{ name: 'core_load_capability', args: { domain: 'minecraft' } }],
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'core_load_capability', args: { domain: 'minecraft' } } }],
            },
          };
        }
        secondTurnToolNames = req.tools.map(t => t.name);
        return {
          text: 'Ok',
          calls: [],
          content: {
            role: 'model',
            parts: [{ text: JSON.stringify({ outcome: 'conversation', text: 'Entendido.', effects: [] }) }],
          },
        };
      },
    };

    await naturalToolLoopV2(
      ctx, mockLlm, catalog, context, exposure, 'system', 'revisa minecraft', [], metrics,
    );

    expect(metrics.capabilityExpansion).toBe(0);
    // core.load_capability was denied as not exposed
    expect(secondTurnToolNames).not.toContain('core_load_capability');
  });
});
