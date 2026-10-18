import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { localPresenterV2 } from '../src/core/composer-v2.js';
import { GeminiKeyPool, GeminiAttemptError } from '../src/core/gemini-key-pool.js';
import { Evolution } from '../src/wa/evolution.js';
import { readConfig } from '../src/config.js';
import { naturalRouterSystemV2 } from '../src/core/router-v2.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { resolveReferences } from '../src/core/policy-v2/references.js';
import { evaluateToolPolicy } from '../src/core/policy-v2/evaluate.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import { ToolExposureTurn } from '../src/core/tool-exposure.js';
import type { ExecutionContextV2 } from '../src/core/policy-v2/types.js';

describe('Incident WhatsApp Hotfix Regressions', () => {
  describe('Composer V2 Presentation', () => {
    it('presents REF_INCOMPATIBLE clearly instead of vague error or clarification', () => {
      const text = localPresenterV2({
        toolName: 'media.process',
        status: 'denied',
        domain: 'media',
        code: 'REF_INCOMPATIBLE',
        data: {},
      });
      expect(text).toBe('Ese archivo no es compatible con la operación solicitada.');
    });

    it('presents queued Minecraft operations as starting instead of unconfirmed warning', () => {
      const text = localPresenterV2({
        toolName: 'minecraft.start',
        status: 'queued',
        domain: 'minecraft',
        code: 'QUEUED',
        data: {},
      });
      expect(text).toBe('Va, ejecutando la operación de Minecraft...');
      expect(text).not.toContain('Todavía no está confirmado el cambio');
    });
  });

  describe('Key Pool Cooldown Kind Tracking', () => {
    const quiet = { log: () => undefined };

    it('identifies cooldown caused by 503 as provider error, never false quota', async () => {
      const now = 1000;
      const pool = new GeminiKeyPool(['key-1'], { ...quiet, now: () => now });
      const provErr = new GeminiAttemptError('provider', 503);

      await expect(pool.run(async () => { throw provErr; })).rejects.toMatchObject({
        kind: 'provider',
      });

      // While cooling down:
      await expect(pool.run(async () => 'ok')).rejects.toMatchObject({
        kind: 'provider',
      });
    });

    it('identifies cooldown caused by timeout as timeout error, never false quota', async () => {
      const now = 1000;
      const pool = new GeminiKeyPool(['key-1'], { ...quiet, now: () => now });
      const timeoutErr = new GeminiAttemptError('timeout');

      await expect(pool.run(async () => { throw timeoutErr; })).rejects.toMatchObject({
        kind: 'timeout',
      });

      // While cooling down:
      await expect(pool.run(async () => 'ok')).rejects.toMatchObject({
        kind: 'timeout',
      });
    });

    it('identifies cooldown caused by 429 as quota error', async () => {
      const now = 1000;
      const pool = new GeminiKeyPool(['key-1'], { ...quiet, now: () => now });
      const quotaErr = new GeminiAttemptError('quota', 429, 60000);

      await expect(pool.run(async () => { throw quotaErr; })).rejects.toMatchObject({
        kind: 'quota',
      });

      // While cooling down:
      await expect(pool.run(async () => 'ok')).rejects.toMatchObject({
        kind: 'quota',
      });
    });
  });

  describe('Evolution Audio Voice Note Routing', () => {
    const provider = Fastify({ logger: false });
    let receivedEndpoint = '';
    let receivedPayload: unknown;

    provider.post('/message/sendWhatsAppAudio/botsky', async (req) => {
      receivedEndpoint = 'sendWhatsAppAudio';
      receivedPayload = req.body;
      return { key: { id: 'voice-note-1', remoteJid: '300@g.us', fromMe: true } };
    });

    provider.post('/message/sendMedia/botsky', async (req) => {
      receivedEndpoint = 'sendMedia';
      receivedPayload = req.body;
      return { key: { id: 'media-1', remoteJid: '300@g.us', fromMe: true } };
    });

    let adapter: Evolution;

    beforeAll(async () => {
      const url = await provider.listen({ host: '127.0.0.1', port: 0 });
      adapter = new Evolution(readConfig({
        ROUTER_MODE: 'v1',
        GEMINI_API_KEY: 'fixture-gemini-key',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        EVOLUTION_URL: url,
        EVOLUTION_APIKEY: 'test-api-key',
        INSTANCE: 'botsky',
        WEBHOOK_SECRET: 'x'.repeat(32),
        OWNER_JIDS: '100@s.whatsapp.net',
        BOT_JIDS: '200@s.whatsapp.net',
        LAB_CHAT_ID: '300@g.us',
        TRANSPORT: 'mock',
      }));
    });

    afterAll(() => provider.close());

    it('routes media.kind=audio to sendWhatsAppAudio with number and audio payload', async () => {
      const delivery = {
        id: 'del-1',
        chatId: '300@g.us',
        text: 'aquí está tu audio',
        sourceId: 'inbound-voice-req',
        media: {
          kind: 'audio' as const,
          mime: 'audio/ogg; codecs=opus',
          base64: 'T2dnUwACAAAAAAAAAAA...',
        },
      };

      const result = await adapter.send(delivery);
      expect(result).toEqual({ status: 'sent', id: 'voice-note-1' });
      expect(receivedEndpoint).toBe('sendWhatsAppAudio');
      expect(receivedPayload).toEqual({
        number: '300@g.us',
        audio: 'T2dnUwACAAAAAAAAAAA...',
        quoted: {
          key: {
            id: 'inbound-voice-req',
            remoteJid: '300@g.us',
          },
        },
      });
    });
  });

  describe('Persona vs Tool Priority & Tool Registry speak', () => {
    it('naturalRouterSystemV2 contains tool priority rule over persona banter', () => {
      const registry = createRegistry();
      const catalog = createToolRegistryV2(registry);
      const turn = new ToolExposureTurn(catalog, { actorRole: 'owner', chatType: 'group', enabledModules: ['media'], toolCallingMode: 'full_96' });
      const systemPrompt = naturalRouterSystemV2(turn, 'full_96');

      expect(systemPrompt).toContain('Prioridad de herramientas:');
      expect(systemPrompt).toContain('media_process speak');
      expect(systemPrompt).toContain('La personalidad nunca sustituye una acción disponible.');
    });

    it('media.process registry description explains operation=speak for audio and voice notes', () => {
      const registry = createRegistry();
      const catalog = createToolRegistryV2(registry);
      const meta = catalog.find(t => t.name === 'media.process');
      expect(meta).toBeDefined();
      expect(meta?.descriptionForModel).toContain('operation=speak');
      expect(meta?.descriptionForModel).toContain('audio o nota de voz');
    });
  });

  describe('Policy Incompatible Artifact Handling', () => {
    const safeRefs = new SafeRefs([{
      kind: 'artifactRef',
      id: 'art-pdf-1',
      chatId: 'chat-1',
      label: 'document.pdf',
      access: { visibility: 'personal', ownerId: 'usr-1' },
    }]);
    const safeRef = safeRefs.list({ chatId: 'chat-1', actorId: 'usr-1' })[0]!.ref;

    it('resolveReferences flags incompatible artifact as failure: incompatible', async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('WHERE a.id=$1')) {
          return { rows: [{ id: 'art-pdf-1', mime: 'application/pdf', type: 'document', sha256: 'deadbeef' }] };
        }
        return { rows: [{ id: 'art-pdf-1', mime: 'application/pdf', type: 'document', sha256: 'deadbeef', is_current: true, is_reply: false, is_recent: false, created_at: new Date() }] };
      });

      const ctx = {
        actorId: 'usr-1',
        chatId: 'chat-1',
        isOwner: true,
        isAdmin: true,
        isPrivate: false,
        envelope: {
          CHAT_METADATA: { isGroup: true },
          SESSION_STATE: null,
          ARTIFACT_STATE: {
            CURRENT: [{ ref: safeRef, mime: 'application/pdf', category: 'pdf' }],
            RECENT: [],
            REPLIED: null,
          },
        },
        safeRefMap: safeRefs,
        legacy: {
          c: {
            query: mockQuery,
            chatArtifacts: {
              get: vi.fn().mockResolvedValue({
                id: 'art-pdf-1',
                mime: 'application/pdf',
                type: 'document',
                sha256: 'deadbeef',
              }),
            },
          },
          msg: { quoted: null, attachments: [] },
        },
      } as unknown as ExecutionContextV2;

      // office_pdf only accepts docx, xlsx, pptx; passing a pdf must return failure='incompatible'
      const resolved = await resolveReferences(ctx, {
        operation: 'office_pdf',
        artifactRef: safeRef,
      }, 'office_pdf');

      expect(resolved.failure).toBe('incompatible');
    });

    it('evaluateToolPolicy returns denied REF_INCOMPATIBLE when artifact is incompatible', async () => {
      const registry = createRegistry();
      const catalog = createToolRegistryV2(registry);
      const tool = catalog.find(t => t.name === 'media.process')!;
      const legacyTool = registry.all().find(t => t.name === 'media.process')!;

      const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('system_flags')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('WHERE a.id=$1')) {
          return { rows: [{ id: 'art-pdf-1', mime: 'application/pdf', type: 'document', sha256: 'deadbeef' }] };
        }
        return { rows: [{ id: 'art-pdf-1', mime: 'application/pdf', type: 'document', sha256: 'deadbeef', is_current: true, is_reply: false, is_recent: false, created_at: new Date() }] };
      });

      const ctx = {
        actorId: 'usr-1',
        chatId: 'chat-1',
        role: 'owner',
        chat: { enabled: true, isGroup: true, settings: { modules: { media: true } } },
        actor: { groupMember: true },
        envelope: {
          CHAT_METADATA: { isGroup: true },
          SESSION_STATE: null,
          ARTIFACT_STATE: {
            CURRENT: [{ ref: safeRef, mime: 'application/pdf', category: 'pdf' }],
            RECENT: [],
            REPLIED: null,
          },
        },
        safeRefMap: safeRefs,
        legacy: {
          c: {
            query: mockQuery,
            chatArtifacts: {
              get: vi.fn().mockResolvedValue({
                id: 'art-pdf-1',
                mime: 'application/pdf',
                type: 'document',
                sha256: 'deadbeef',
              }),
            },
          },
          config: { MINECRAFT_ENABLED: true, DRIVE_ENABLED: true },
          msg: { quoted: null, attachments: [] },
        },
      } as unknown as ExecutionContextV2;

      const decision = await evaluateToolPolicy(ctx, tool, legacyTool, {
        operation: 'office_pdf',
        artifactRef: safeRef,
      });

      expect(decision.status).toBe('denied');
      expect(decision.denialCode).toBe('REF_INCOMPATIBLE');
    });
  });
});
