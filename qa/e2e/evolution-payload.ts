import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeMessage } from '../../src/wa/normalize.js';
import type { EvolutionPayloadOptions } from './types.js';

export function generateProviderMessageId(prefix = 'QA'): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(8).toString('hex').toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

export function loadFixtureBuffer(fixturePath: string): { buffer: Buffer; mime: string } {
  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  const buffer = readFileSync(fixturePath);
  let mime = 'application/octet-stream';
  if (fixturePath.endsWith('.jpg') || fixturePath.endsWith('.jpeg')) mime = 'image/jpeg';
  else if (fixturePath.endsWith('.png')) mime = 'image/png';
  else if (fixturePath.endsWith('.pdf')) mime = 'application/pdf';
  else if (fixturePath.endsWith('.ogg')) mime = 'audio/ogg';
  else if (fixturePath.endsWith('.mp3')) mime = 'audio/mpeg';
  else if (fixturePath.endsWith('.mp4')) mime = 'video/mp4';
  return { buffer, mime };
}

/**
 * Builds an authentic Evolution v2.3.7 webhook payload matching normalizeData schema.
 */
export function buildEvolutionPayload(options: EvolutionPayloadOptions): Record<string, unknown> {
  const instance = options.instance ?? 'botsky';
  const providerMessageId = options.providerMessageId ?? generateProviderMessageId();
  const isGroup = options.isGroup ?? options.chatId.endsWith('@g.us');
  const messageTimestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  const key: Record<string, unknown> = {
    id: providerMessageId,
    remoteJid: options.chatId,
    fromMe: false,
  };
  if (isGroup) {
    key.participant = options.actorId;
  }

  const contextInfo: Record<string, unknown> = {
    mentionedJid: options.mentions ?? [],
  };

  if (options.quoted) {
    contextInfo.stanzaId = options.quoted.stanzaId;
    if (options.quoted.participant) {
      contextInfo.participant = options.quoted.participant;
    }
    const quotedMsg: Record<string, unknown> = {};
    if (options.quoted.text) {
      quotedMsg.conversation = options.quoted.text;
    }
    if (options.quoted.image) {
      quotedMsg.imageMessage = {
        mimetype: 'image/jpeg',
        caption: options.quoted.text ?? '',
      };
    }
    contextInfo.quotedMessage = quotedMsg;
  }

  const message: Record<string, unknown> = {};

  const attachments = options.attachments ?? [];

  if (attachments.length === 0) {
    // Pure text message
    const text = options.text ?? '';
    if (options.quoted || (options.mentions && options.mentions.length > 0)) {
      message.extendedTextMessage = {
        text,
        contextInfo,
      };
    } else {
      message.conversation = text;
    }
  } else {
    // Media message
    for (const att of attachments) {
      let mime = att.mimetype;
      const fileName = att.fileName;

      if (att.fixturePath && existsSync(att.fixturePath)) {
        const fixture = loadFixtureBuffer(att.fixturePath);
        mime = mime ?? fixture.mime;
      }

      const mediaObj: Record<string, unknown> = {
        mimetype: mime,
        caption: att.caption ?? options.text ?? '',
        contextInfo,
      };

      if (att.kind === 'image') {
        message.imageMessage = mediaObj;
      } else if (att.kind === 'document') {
        mediaObj.fileName = fileName ?? 'document.pdf';
        message.documentMessage = mediaObj;
      } else if (att.kind === 'audio') {
        message.audioMessage = mediaObj;
      } else if (att.kind === 'video') {
        message.videoMessage = mediaObj;
      } else if (att.kind === 'sticker') {
        message.stickerMessage = mediaObj;
      }
    }
  }

  const payload = {
    event: 'messages.upsert',
    instance,
    data: {
      key,
      message,
      messageTimestamp,
      contextInfo: Object.keys(contextInfo).length > 0 ? contextInfo : undefined,
    },
  };

  // Validate that Botsky's production normalizer can parse this payload cleanly
  const normalized = normalizeMessage(payload, instance);
  if (!normalized) {
    throw new Error(`Generated Evolution payload failed normalizeMessage validation: ${JSON.stringify(payload)}`);
  }

  return payload;
}
