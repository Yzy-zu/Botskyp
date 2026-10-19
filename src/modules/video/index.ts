import { z } from 'zod';
import { defineTool, ok, fail, type Tool } from '../../core/tools.js';
import { product } from '../../../config/product.js';
import {
  saveVideoSearchSession,
  findVideoByRef,
  type NormalizedVideoResult,
} from './session.js';

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

import { createDefaultRegistry } from './providers/index.js';

const defaultVideoRegistry = createDefaultRegistry();

export async function searchVideos(
  query: string,
  source: 'auto' | 'web' | 'dailymotion' | 'adult' | 'pornhub' | 'xnxx' = 'auto',
  limit: number = product.videoMaxSearchResults,
  registry = defaultVideoRegistry
): Promise<NormalizedVideoResult[]> {
  const providerResults = await registry.search(query, { source, limit });
  return providerResults.map(item => ({
    id: item.id,
    videoRef: item.videoRef ?? item.id,
    title: item.title,
    webpageUrl: item.webpageUrl,
    duration: item.durationSeconds,
    durationSeconds: item.durationSeconds,
    provider: item.provider,
    uploader: item.uploader,
    thumbnailUrl: item.thumbnailUrl,
    downloadable: item.downloadable,
    metadata: item.metadata,
  }));
}

const base = {
  module: 'video',
  permission: 'chat.use',
  scope: 'both',
  modelCallable: true,
} as const;

export const videoTools: Tool[] = [
  defineTool({
    ...base,
    name: 'video.search',
    risk: 'read',
    capability: {
      summary: 'Buscar videos en internet.',
      produces: 'lista de videos',
    },
    description:
      'Buscar videos en internet (Dailymotion, web, adultos) y seleccionar un resultado por su videoRef.',
    examples: ['bot busca video tutorial cocina', 'bot videos de gatos'],
    args: z.strictObject({
      query: z.string().trim().min(1).max(product.searchQueryChars),
      source: z
        .enum(['auto', 'web', 'dailymotion', 'adult', 'pornhub', 'xnxx'])
        .optional(),
      limit: z.number().int().positive().max(10).optional(),
    }),
    async run(ctx, args) {
      const results = await searchVideos(
        args.query,
        args.source ?? 'auto',
        args.limit ?? product.videoMaxSearchResults
      );
      if (!results.length) {
        return fail('No se encontraron videos para tu búsqueda.');
      }
      const sessionTtl = (args.source === 'adult' || args.source === 'pornhub' || args.source === 'xnxx')
        ? 10
        : product.videoSessionMinutes;
      await saveVideoSearchSession(
        ctx.c,
        ctx.chat.id,
        ctx.actor.id,
        args.query,
        args.source ?? 'auto',
        results,
        sessionTtl
      );
      const presentation = results
        .map(
          (item, index) =>
            `${index + 1}. ${item.title}\n   ${formatDuration(item.duration)} · ${item.provider}`
        )
        .join('\n');
      return ok(presentation, { results });
    },
  }),

  defineTool({
    ...base,
    name: 'video.info',
    risk: 'read',
    capability: {
      summary: 'Consultar detalles y metadatos de un video.',
      produces: 'metadatos de video',
    },
    description:
      'Consultar información detallada y metadatos de un video de la búsqueda activa mediante su videoRef.',
    examples: ['bot info video videoRef_...'],
    args: z.strictObject({
      videoRef: z.string().min(1),
    }),
    async run(ctx, args) {
      const video = await findVideoByRef(
        ctx.c,
        ctx.chat.id,
        ctx.actor.id,
        args.videoRef
      );
      if (!video) {
        return fail('Video no encontrado o la sesión de búsqueda ha expirado.');
      }
      const presentation = [
        `*${video.title}*`,
        `Proveedor: ${video.provider}`,
        `Duración: ${formatDuration(video.duration)}`,
        video.uploader ? `Canal: ${video.uploader}` : undefined,
        `Enlace: ${video.webpageUrl}`,
        video.description
          ? `Descripción: ${video.description.slice(0, 300)}`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      return ok(presentation, { video });
    },
  }),

  defineTool({
    ...base,
    name: 'video.download',
    risk: 'write',
    capability: {
      summary: 'Descargar video o audio a cola de procesamiento.',
      produces: 'trabajo asíncrono',
    },
    description:
      'Descargar un video o audio de la búsqueda activa mediante su videoRef. Se procesa en cola de forma asíncrona.',
    examples: ['bot descarga video videoRef_...'],
    args: z.strictObject({
      videoRef: z.string().min(1),
      mode: z.enum(['video', 'audio']).optional(),
      quality: z.enum(['best', '720p', '480p', '360p']).optional(),
    }),
    async run(ctx, args) {
      const video = await findVideoByRef(
        ctx.c,
        ctx.chat.id,
        ctx.actor.id,
        args.videoRef
      );
      if (!video) {
        return fail('Video no encontrado o la sesión de búsqueda ha expirado.');
      }
      if (video.downloadable === false) {
        return fail('Este video no está disponible para descarga directa.');
      }
      if (video.duration && video.duration > product.videoMaxDurationSeconds) {
        return fail(
          `El video supera la duración máxima permitida de ${Math.floor(
            product.videoMaxDurationSeconds / 60
          )} minutos.`
        );
      }
      const payload = {
        url: video.webpageUrl,
        title: video.title,
        mode: args.mode ?? 'video',
        quality: args.quality ?? 'best',
        provider: video.provider,
        duration: video.duration,
        videoRef: args.videoRef,
      };
      const row = (
        await ctx.c.query<{ id: string }>(
          `INSERT INTO jobs (kind, payload, chat_id, owner_id, source_message_id)
           VALUES ('video', $1, $2, $3, $4)
           RETURNING id`,
          [JSON.stringify(payload), ctx.chat.id, ctx.actor.id, ctx.msg.id]
        )
      ).rows[0];
      const jobId = row!.id;
      return ok(
        `Descarga iniciada para "${video.title}" en cola (#${jobId}).`,
        { jobId, ...payload }
      );
    },
  }),
];
