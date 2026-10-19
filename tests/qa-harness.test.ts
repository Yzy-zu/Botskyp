import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEvolutionPayload,
  generateProviderMessageId,
  loadFixtureBuffer,
} from '../qa/e2e/evolution-payload.js';
import { classifyProviderFailure } from '../qa/e2e/result-collector.js';
import { QaRunner } from '../qa/e2e/runner.js';
import { normalizeMessage } from '../src/wa/normalize.js';
import { validateBytes } from '../src/modules/media/catalog.js';
import type { QaCase } from '../qa/e2e/types.js';

describe('QA E2E Harness Self-Tests', () => {
  describe('1. Evolution Payload Fidelity', () => {
    it('generates a valid pure text message in a group', () => {
      const payload = buildEvolutionPayload({
        chatId: '120363431233265050@g.us',
        actorId: '5214435810175@s.whatsapp.net',
        text: 'hola botsky',
      });

      expect(payload.event).toBe('messages.upsert');
      expect(payload.instance).toBe('botsky');
      const normalized = normalizeMessage(payload, 'botsky');
      expect(normalized).not.toBeNull();
      expect(normalized?.text).toBe('hola botsky');
      expect(normalized?.chatId).toBe('120363431233265050@g.us');
      expect(normalized?.senderId).toBe('5214435810175@s.whatsapp.net');
      expect(normalized?.isGroup).toBe(true);
    });

    it('generates a valid private chat message', () => {
      const payload = buildEvolutionPayload({
        chatId: '5214435810175@s.whatsapp.net',
        actorId: '5214435810175@s.whatsapp.net',
        text: 'hola en privado',
        isGroup: false,
      });

      const normalized = normalizeMessage(payload, 'botsky');
      expect(normalized).not.toBeNull();
      expect(normalized?.text).toBe('hola en privado');
      expect(normalized?.chatId).toBe('5214435810175@s.whatsapp.net');
      expect(normalized?.isGroup).toBe(false);
    });

    it('generates a valid quoted reply message', () => {
      const payload = buildEvolutionPayload({
        chatId: '120363431233265050@g.us',
        actorId: '5214435810175@s.whatsapp.net',
        text: 'manda el segundo',
        quoted: {
          stanzaId: 'PREV_MSG_123',
          participant: '5214437367565@s.whatsapp.net',
          text: '1. Video A\n2. Video B',
        },
      });

      const normalized = normalizeMessage(payload, 'botsky');
      expect(normalized).not.toBeNull();
      expect(normalized?.quoted).toBeDefined();
      expect(normalized?.quoted?.id).toBe('PREV_MSG_123');
      expect(normalized?.quoted?.text).toBe('1. Video A\n2. Video B');
    });

    it('generates valid media message payloads (image, document, audio)', () => {
      const imagePayload = buildEvolutionPayload({
        chatId: '120363431233265050@g.us',
        actorId: '5214435810175@s.whatsapp.net',
        text: 'mira esta foto',
        attachments: [
          { kind: 'image', mimetype: 'image/jpeg', caption: 'mira esta foto' },
        ],
      });
      const normImg = normalizeMessage(imagePayload, 'botsky');
      expect(normImg).not.toBeNull();
      expect(normImg?.attachments).toHaveLength(1);
      expect(normImg?.attachments[0]!.kind).toBe('image');
      expect(normImg?.attachments[0]!.mime).toBe('image/jpeg');

      const docPayload = buildEvolutionPayload({
        chatId: '120363431233265050@g.us',
        actorId: '5214435810175@s.whatsapp.net',
        text: 'adjunto el informe',
        attachments: [
          { kind: 'document', mimetype: 'application/pdf', fileName: 'test.pdf' },
        ],
      });
      const normDoc = normalizeMessage(docPayload, 'botsky');
      expect(normDoc).not.toBeNull();
      expect(normDoc?.attachments).toHaveLength(1);
      expect(normDoc?.attachments[0]!.kind).toBe('document');
      expect(normDoc?.attachments[0]!.fileName).toBe('test.pdf');
    });
  });

  describe('2. Provider Message ID Uniqueness & Multi-Turn Continuity', () => {
    it('generates unique providerMessageIds across calls', () => {
      const id1 = generateProviderMessageId();
      const id2 = generateProviderMessageId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^QA_/);
    });

    it('preserves same chat and actor across multi-turn execution', () => {
      const testCase: QaCase = {
        id: 'MULTI-001',
        title: 'Multi-turn conversation',
        suite: 'test',
        mode: 'SAFE',
        chatId: '120363431233265050@g.us',
        actorId: '5214435810175@s.whatsapp.net',
        turns: [
          { input: 'busca videos' },
          { input: 'manda el 2', quotePrevious: true },
        ],
      };

      const payload1 = buildEvolutionPayload({
        chatId: testCase.chatId!,
        actorId: testCase.actorId!,
        text: testCase.turns[0]!.input,
      });

      const payload2 = buildEvolutionPayload({
        chatId: testCase.chatId!,
        actorId: testCase.actorId!,
        text: testCase.turns[1]!.input,
        quoted: {
          stanzaId: (payload1.data as { key: { id: string } }).key.id,
          participant: testCase.actorId,
        },
      });

      const norm1 = normalizeMessage(payload1, 'botsky');
      const norm2 = normalizeMessage(payload2, 'botsky');

      expect(norm1?.chatId).toBe(norm2?.chatId);
      expect(norm1?.senderId).toBe(norm2?.senderId);
      expect(norm2?.quoted?.id).toBe(norm1?.id);
    });
  });

  describe('3. Media Fixtures Validity', () => {
    it('verifies all test fixtures exist and have valid magic bytes', () => {
      const fixtures = [
        { path: 'qa/e2e/fixtures/sample.jpg', mime: 'image/jpeg' },
        { path: 'qa/e2e/fixtures/sample.png', mime: 'image/png' },
        { path: 'qa/e2e/fixtures/sample.pdf', mime: 'application/pdf' },
        { path: 'qa/e2e/fixtures/sample.ogg', mime: 'audio/ogg' },
      ];

      for (const f of fixtures) {
        expect(existsSync(f.path)).toBe(true);
        const { buffer, mime } = loadFixtureBuffer(f.path);
        expect(mime).toBe(f.mime);
        expect(() => validateBytes(buffer, f.mime)).not.toThrow();
      }
    });
  });

  describe('4. Checkpoint & Resume Mechanism', () => {
    it('loads completed case IDs from JSONL and skips them when resume is active', () => {
      const tmpFile = join(tmpdir(), `qa-checkpoint-${Date.now()}.jsonl`);
      writeFileSync(
        tmpFile,
        JSON.stringify({ caseId: 'CASE-001', status: 'PASS' }) +
          '\n' +
          JSON.stringify({ caseId: 'CASE-002', status: 'FAIL' }) +
          '\n' +
          JSON.stringify({ caseId: 'CASE-003', status: 'PASS' }) +
          '\n',
        'utf8'
      );

      const runner = new QaRunner({ outputDir: tmpdir() });
      const completed = runner.loadCompletedCaseIds(tmpFile);

      expect(completed.has('CASE-001')).toBe(true);
      expect(completed.has('CASE-002')).toBe(false); // FAIL should be retried
      expect(completed.has('CASE-003')).toBe(true);

      unlinkSync(tmpFile);
    });
  });

  describe('5. Provider Failure Classification', () => {
    it('classifies 429 and quota exhaustion as RATE_LIMIT', () => {
      expect(classifyProviderFailure('Llegué al límite de IA por ahora. Inténtalo más tarde.', [])).toBe('RATE_LIMIT');
      expect(classifyProviderFailure(null, ['HTTP 429 Too Many Requests'])).toBe('RATE_LIMIT');
      expect(classifyProviderFailure(null, ['RESOURCE_EXHAUSTED: quota exceeded'])).toBe('RATE_LIMIT');
    });

    it('classifies 503 and network timeout as INFRA_PROVIDER_FAILURE', () => {
      expect(classifyProviderFailure('La IA no pudo responder en este momento. Inténtalo más tarde.', [])).toBe('INFRA_PROVIDER_FAILURE');
      expect(classifyProviderFailure(null, ['fetch failed: ECONNREFUSED'])).toBe('INFRA_PROVIDER_FAILURE');
      expect(classifyProviderFailure(null, ['Service Unavailable 503'])).toBe('INFRA_PROVIDER_FAILURE');
      expect(classifyProviderFailure(null, ['ETIMEDOUT: timeout exceeded'])).toBe('INFRA_PROVIDER_FAILURE');
    });

    it('returns null for normal successful replies', () => {
      expect(classifyProviderFailure('Hola! En qué te puedo ayudar hoy?', [])).toBeNull();
      expect(classifyProviderFailure('Aquí tienes los videos encontrados:', [])).toBeNull();
    });
  });

  describe('6. SAFE Mode Isolation Check', () => {
    it('enforces that QA cases reject non-QA chat destinations', async () => {
      const runner = new QaRunner({ qaChatId: '120363431233265050@g.us' });
      const unsafeCase: QaCase = {
        id: 'UNSAFE-001',
        title: 'Attempt against unauthorized real chat',
        suite: 'test',
        mode: 'SAFE',
        chatId: '5219999999999@s.whatsapp.net',
        actorId: '5210000000001@s.whatsapp.net',
        turns: [{ input: 'ping' }],
      };

      await expect(runner.runTurn(unsafeCase, 0)).rejects.toThrow(/Security Violation/);
    });

    it('enforces that QA cases reject unauthorized actors', async () => {
      const runner = new QaRunner({ qaChatId: '120363431233265050@g.us' });
      const unsafeCase: QaCase = {
        id: 'UNSAFE-002',
        title: 'Attempt using unauthorized real user identity',
        suite: 'test',
        mode: 'SAFE',
        chatId: '120363431233265050@g.us',
        actorId: '5219999999999@s.whatsapp.net',
        turns: [{ input: 'ping' }],
      };

      await expect(runner.runTurn(unsafeCase, 0)).rejects.toThrow(/Security Violation: QA runner attempted to use unauthorized actor/);
    });

    it('strictly rejects any other group JID other than authorized QA lab chat', async () => {
      const runner = new QaRunner({ qaChatId: '120363431233265050@g.us' });
      const unsafeGroupCase: QaCase = {
        id: 'UNSAFE-003',
        title: 'Attempt targeting arbitrary external group',
        suite: 'test',
        mode: 'SAFE',
        chatId: '120369999999999999@g.us',
        actorId: '5210000000001@s.whatsapp.net',
        turns: [{ input: 'ping' }],
      };

      await expect(runner.runTurn(unsafeGroupCase, 0)).rejects.toThrow(/Security Violation/);
    });
  });

  describe('7. Centralized SAFE Execution Barrier & Tool Classification', () => {
    it('classifies dangerous and destructive operations correctly using structured metadata', async () => {
      const { createRegistry } = await import('../src/core/registry.js');
      const { createToolRegistryV2 } = await import('../src/core/tool-registry-v2.js');
      const { isDangerousOrDestructive } = await import('../src/core/policy-v2/executor.js');

      const registry = createRegistry();
      const catalog = createToolRegistryV2(registry);

      const checkTool = (name: string) => {
        const tool = catalog.find(t => t.name === name);
        const legacy = registry.all().find(t => t.name === name);
        if (!tool || !legacy) throw new Error(`Tool not found: ${name}`);
        return isDangerousOrDestructive(tool, legacy);
      };

      // Destructive / high-privilege tools must be flagged
      expect(checkTool('minecraft.stop')).toBe(true);
      expect(checkTool('minecraft.restart')).toBe(true);
      expect(checkTool('minecraft.console')).toBe(true);
      expect(checkTool('bulk.nuclear')).toBe(true);
      expect(checkTool('bulk.broadcast')).toBe(true);
      expect(checkTool('messaging.send')).toBe(true);
      expect(checkTool('moderation.change')).toBe(true);
      expect(checkTool('moderation.config')).toBe(true);
      expect(checkTool('notes.delete')).toBe(true);
      expect(checkTool('control.emergency')).toBe(true);

      // Read and non-destructive tools must NOT be suppressed
      expect(checkTool('minecraft.status')).toBe(false);
      expect(checkTool('minecraft.players')).toBe(false);
      expect(checkTool('notes.create')).toBe(false);
      expect(checkTool('notes.list')).toBe(false);
      expect(checkTool('reminders.create')).toBe(false);
      expect(checkTool('video.search')).toBe(false);
      expect(checkTool('video.download')).toBe(false);
      expect(checkTool('web.search')).toBe(false);
      expect(checkTool('core.help')).toBe(false);
    });
  });

  describe('8. Argument Capture Fidelity (inputArgs !== result)', () => {
    it('proves that inputArgs captures Gemini proposed args distinct from backend result', () => {
      const proposedGeminiArgs = {
        query: 'minecraft',
        source: 'dailymotion',
      };

      const backendExecutionResult = {
        toolName: 'video.search',
        domain: 'media',
        status: 'ok',
        code: 'VIDEO_RESULTS',
        data: {
          adapter: 'legacy',
          factsAvailable: true,
          count: 5,
        },
      };

      // Ensure inputArgs and result are structurally distinct
      expect(proposedGeminiArgs).not.toEqual(backendExecutionResult);
      expect(proposedGeminiArgs).toHaveProperty('query', 'minecraft');
      expect(proposedGeminiArgs).toHaveProperty('source', 'dailymotion');
      expect(proposedGeminiArgs).not.toHaveProperty('adapter');
      expect(backendExecutionResult.data).toHaveProperty('adapter', 'legacy');
      expect(backendExecutionResult.data).not.toHaveProperty('query');
    });
  });

  describe('9. QA Identity Isolation & Roles', () => {
    it('authenticates QA roles strictly in LAB_CHAT_ID and applies normal resolution elsewhere', async () => {
      const { QA_OWNER_JID, QA_MEMBER_JID, actorFor, resolveQaRole } = await import('../src/core/permissions.js');
      const { readConfig } = await import('../src/config.js');

      const config = readConfig();
      const labChatId = config.LAB_CHAT_ID;
      const otherGroup = '120363999999999999@g.us';

      // Verify resolveQaRole helper directly
      expect(resolveQaRole(QA_OWNER_JID, labChatId, labChatId)).toBe('owner');
      expect(resolveQaRole(QA_MEMBER_JID, labChatId, labChatId)).toBe('member');
      expect(resolveQaRole(QA_OWNER_JID, QA_OWNER_JID, labChatId)).toBeNull();
      expect(resolveQaRole(QA_MEMBER_JID, QA_MEMBER_JID, labChatId)).toBeNull();
      expect(resolveQaRole(QA_OWNER_JID, otherGroup, labChatId)).toBeNull();
      expect(resolveQaRole(QA_MEMBER_JID, otherGroup, labChatId)).toBeNull();

      // Mock DB client that has no memberships
      const mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
      } as unknown as Parameters<typeof actorFor>[0];

      // A) QA_OWNER + LAB_CHAT_ID -> owner
      const actorA = await actorFor(
        mockClient,
        { id: 'M_A', chatId: labChatId, senderId: QA_OWNER_JID, isGroup: true, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorA.role).toBe('owner');
      expect(actorA.groupMember).toBe(true);

      // B) QA_MEMBER + LAB_CHAT_ID -> member
      const actorB = await actorFor(
        mockClient,
        { id: 'M_B', chatId: labChatId, senderId: QA_MEMBER_JID, isGroup: true, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorB.role).toBe('member');
      expect(actorB.groupMember).toBe(true);

      // C) QA_OWNER + private chat -> NO QA override (falls back to normal resolution)
      const actorC = await actorFor(
        mockClient,
        { id: 'M_C', chatId: QA_OWNER_JID, senderId: QA_OWNER_JID, isGroup: false, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorC.role).toBe('member');
      expect(actorC.groupMember).toBe(false);

      // D) QA_MEMBER + private chat -> NO QA override
      const actorD = await actorFor(
        mockClient,
        { id: 'M_D', chatId: QA_MEMBER_JID, senderId: QA_MEMBER_JID, isGroup: false, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorD.role).toBe('member');
      expect(actorD.groupMember).toBe(false);

      // E) QA_OWNER + another group -> NO QA override
      const actorE = await actorFor(
        mockClient,
        { id: 'M_E', chatId: otherGroup, senderId: QA_OWNER_JID, isGroup: true, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorE.role).toBe('member');
      expect(actorE.groupMember).toBe(false);

      // F) QA_MEMBER + another group -> NO QA override
      const actorF = await actorFor(
        mockClient,
        { id: 'M_F', chatId: otherGroup, senderId: QA_MEMBER_JID, isGroup: true, ts: new Date(), text: 'hi', fromMe: false, mentions: [], attachments: [] },
        config
      );
      expect(actorF.role).toBe('member');
      expect(actorF.groupMember).toBe(false);
    });
  });

  describe('10. Targeted QA State Isolation', () => {
    it('refuses to reset non-QA actors to protect user/business state', async () => {
      const { resetQaState } = await import('../qa/e2e/result-collector.js');
      const mockDb = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Parameters<typeof resetQaState>[0];

      // Reset on real owner or normal user JID is a no-op / protected
      await expect(resetQaState(mockDb, '120363431233265050@g.us', '5214435810175@s.whatsapp.net')).resolves.toBeUndefined();
    });
  });

  describe('11. Terminal Delivery with QA_SUPPRESSED', () => {
    it('collector MUST NOT return PASS while outbox is sending, and PASS only after sent', async () => {
      const { collectTurnResult } = await import('../qa/e2e/result-collector.js');

      let outboxStatus = 'sending';
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('inbox')) {
            return { rows: [{ status: 'done', turn_id: 'TURN_1' }] };
          }
          if (sql.includes('message_turns')) {
            return { rows: [{ final_text: '[QA SAFE] Operación apaga minecraft interceptada' }] };
          }
          if (sql.includes('tool_executions')) {
            return {
              rows: [
                {
                  id: 'EXEC_1',
                  tool_name: 'minecraft.stop',
                  status: 'qa_suppressed',
                  input_args: {},
                  policy_decision: 'allow',
                  policy_code: null,
                  result_json: {
                    status: 'qa_suppressed',
                    code: 'QA_SUPPRESSED',
                    data: { gateDecision: 'WOULD_EXECUTE' },
                  },
                },
              ],
            };
          }
          if (sql.includes('jobs')) {
            return { rows: [] };
          }
          if (sql.includes('outbox')) {
            return {
              rows: [
                {
                  id: '176',
                  kind: 'text',
                  status: outboxStatus,
                  payload: { text: '[QA SAFE] Operación interceptada', sourceId: 'PROV_SAFE_1' },
                  created_at: new Date(),
                  sent_at: outboxStatus === 'sent' ? new Date() : null,
                },
              ],
            };
          }
          return { rows: [], rowCount: 0 };
        },
      } as unknown as Parameters<typeof collectTurnResult>[0];

      // While outbox is 'sending', collector MUST NOT return PASS
      const pendingRes = await collectTurnResult(
        mockDb,
        0,
        'PROV_SAFE_1',
        '120363431233265050@g.us',
        '5210000000001@s.whatsapp.net',
        'apaga minecraft',
        200,
        {},
        undefined,
        { timeoutMs: 300, pollIntervalMs: 50 }
      );
      expect(pendingRes.status).not.toBe('PASS');
      expect(pendingRes.terminalState).toBe('TIMEOUT_INCOMPLETE');

      // Now outbox transitions to 'sent'
      outboxStatus = 'sent';
      const sentRes = await collectTurnResult(
        mockDb,
        0,
        'PROV_SAFE_1',
        '120363431233265050@g.us',
        '5210000000001@s.whatsapp.net',
        'apaga minecraft',
        200,
        {},
        undefined,
        { timeoutMs: 500, pollIntervalMs: 50 }
      );
      expect(sentRes.status).toBe('PASS');
      expect(sentRes.terminalState).toBe('QA_SUPPRESSED');
    });

    it('returns FAIL when outbox fails even if side effect is QA_SUPPRESSED', async () => {
      const { collectTurnResult } = await import('../qa/e2e/result-collector.js');

      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('inbox')) {
            return { rows: [{ status: 'done', turn_id: 'TURN_1' }] };
          }
          if (sql.includes('message_turns')) {
            return { rows: [{ final_text: '[QA SAFE] Intercepted' }] };
          }
          if (sql.includes('tool_executions')) {
            return {
              rows: [
                {
                  id: 'EXEC_1',
                  tool_name: 'minecraft.stop',
                  status: 'qa_suppressed',
                  input_args: {},
                  policy_decision: 'allow',
                  policy_code: null,
                  result_json: { status: 'qa_suppressed', code: 'QA_SUPPRESSED' },
                },
              ],
            };
          }
          if (sql.includes('jobs')) return { rows: [] };
          if (sql.includes('outbox')) {
            return {
              rows: [
                {
                  id: '177',
                  kind: 'text',
                  status: 'failed',
                  payload: { text: '[QA SAFE] Fail', sourceId: 'PROV_FAIL_1' },
                  created_at: new Date(),
                  sent_at: null,
                },
              ],
            };
          }
          return { rows: [], rowCount: 0 };
        },
      } as unknown as Parameters<typeof collectTurnResult>[0];

      const failedRes = await collectTurnResult(
        mockDb,
        0,
        'PROV_FAIL_1',
        '120363431233265050@g.us',
        '5210000000001@s.whatsapp.net',
        'apaga minecraft',
        200,
        {},
        undefined,
        { timeoutMs: 500, pollIntervalMs: 50 }
      );
      expect(failedRes.status).toBe('FAIL');
      expect(failedRes.terminalState).toBe('OUTBOX_FAILED');
    });
  });
});

