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
        actorId: '5219999999999@s.whatsapp.net',
        turns: [{ input: 'ping' }],
      };

      await expect(runner.runTurn(unsafeCase, 0)).rejects.toThrow(/Security Violation/);
    });
  });
});
