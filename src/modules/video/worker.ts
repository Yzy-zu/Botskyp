import { observer } from '../../observer/index.js';
import { sanitizeOutputV2 } from '../../core/output-sanitizer-v2.js';
import { registerArtifactV2 } from '../../core/artifact-registration-v2.js';
import { readFile, copyFile, stat, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { product } from '../../../config/product.js';
import { transaction, type Db } from '../../db/client.js';
import { configForChat, type Config } from '../../config.js';
import { mediaAllowed } from '../media/access.js';
import { capacity, digest } from '../media/storage.js';
import { validateBytes } from '../media/catalog.js';
import { downloadVideo } from './downloader.js';
import { transcodeForWhatsApp, probeMedia } from './transcoder.js';
import type { MediaJob } from '../media/worker.js';

export const videoJobPayloadSchema = z.object({
  canonicalUrl: z.string().optional(),
  url: z.string().optional(),
  videoRef: z.string().optional(),
  quality: z.string().optional(),
  mode: z.enum(['video', 'audio']).default('video'),
  title: z.string().optional(),
});
export type VideoJobPayload = z.infer<typeof videoJobPayloadSchema>;

export type VideoWorkerDeps = {
  download: typeof downloadVideo;
  transcode: typeof transcodeForWhatsApp;
  probe: typeof probeMedia;
  tmpRoot?: string | undefined;
};

const defaultDeps: VideoWorkerDeps = {
  download: downloadVideo,
  transcode: transcodeForWhatsApp,
  probe: probeMedia,
};

export function videoFailure(code: string): string {
  const c = code.toUpperCase();
  if (c.includes('TOO_LARGE') || c.includes('SIZE') || c.includes('LIMIT')) {
    return 'El video es demasiado grande o largo para enviarse por WhatsApp (límite 16MB). Intenta con una duración menor o menor resolución.';
  }
  if (c.includes('TIMEOUT')) {
    return 'Se agotó el tiempo de descarga o procesamiento del video. Por favor intenta más tarde.';
  }
  if (c.includes('TRANSCODE_FAILED')) {
    return 'No pude procesar o convertir el video para WhatsApp.';
  }
  if (c.includes('DOWNLOAD_FAILED')) {
    return 'No pude descargar el video. El enlace puede ser privado, inválido o no compatible.';
  }
  if (c.includes('NOT_ALLOWED')) {
    return 'La descarga de videos no está permitida o el módulo está desactivado.';
  }
  if (c.includes('INTERRUPTED')) {
    return 'El trabajo de video fue interrumpido y no pudo terminar. No se entregó el resultado.';
  }
  return 'No pude completar la descarga o procesamiento del video. Por favor verifica el enlace o intenta de nuevo.';
}

async function notifyVideo(
  c: import('pg').PoolClient,
  job: MediaJob,
  text: string,
  mode: Config['ROUTER_MODE'] = 'v1'
): Promise<string> {
  const body = mode === 'v1_1' ? text : `Trabajo #${job.id}: ${text}`;
  return (
    await c.query<{ id: string }>(
      `INSERT INTO outbox(chat_id, payload, dedupe_key) VALUES($1, $2, $3)
       ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,
      [job.chat_id, JSON.stringify({ text: body, sourceId: job.source_message_id }), `video:result:${job.id}:error`]
    )
  ).rows[0]!.id;
}

export async function claimVideoJob(db: Db): Promise<MediaJob | undefined> {
  return transaction(db, async c => {
    const job = (
      await c.query<MediaJob>(
        "SELECT * FROM jobs WHERE kind IN ('video_download', 'video') AND status='queued' AND run_after<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"
      )
    ).rows[0];
    if (job) {
      observer.emit(() => ({ eventType: 'JOB_CLAIMED', stage: 'video.claim', jobId: job.id, payload: job }));
      await c.query("UPDATE jobs SET status='running', attempts=attempts+1, updated_at=now(), error=NULL WHERE id=$1", [
        job.id,
      ]);
    }
    return job;
  });
}

export async function recoverVideoJobs(db: Db, routing: Config | Config['ROUTER_MODE'] = 'v1'): Promise<void> {
  await transaction(db, async c => {
    const rows = (
      await c.query<MediaJob>("SELECT * FROM jobs WHERE kind IN ('video_download', 'video') AND status='running' FOR UPDATE")
    ).rows;
    for (const job of rows) {
      observer.emit(() => ({
        eventType: 'JOB_RECOVERED',
        stage: 'video.startup',
        jobId: job.id,
        payload: { job, reason: 'interrupted' },
      }));
      const mode = typeof routing === 'string' ? routing : configForChat(routing, job.chat_id).ROUTER_MODE;
      const failed = job.attempts >= product.mediaMaxAttempts;
      let outboxId: string | null = null;
      if (failed) {
        outboxId = await notifyVideo(c, job, videoFailure('INTERRUPTED'), mode);
      }
      await c.query(
        "UPDATE jobs SET status=$2, error='interrupted', outbox_id=$3, updated_at=now() WHERE id=$1",
        [job.id, failed ? 'failed' : 'queued', outboxId]
      );
      await c.query(
        "INSERT INTO audit_log(actor_id, chat_id, action, detail) VALUES($1, $2, 'video.recovered', jsonb_build_object('jobId', $3::text, 'result', $4::text))",
        [job.owner_id, job.chat_id, job.id, failed ? 'failed' : 'queued']
      );
    }
  });
}

export async function cleanOrphanVideoTemporaries(root = '/tmp'): Promise<void> {
  try {
    const entries = await readdir(root);
    for (const entry of entries) {
      if (entry.startsWith('botsky-video-')) {
        await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Ignore error
  }
}

async function processVideoJobImpl(
  db: Db,
  config: Config,
  job: MediaJob,
  deps: VideoWorkerDeps = defaultDeps
): Promise<void> {
  config = configForChat(config, job.chat_id);
  const currentStatus = (await db.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0]
    ?.status;
  if (currentStatus !== 'running') return;

  const tmpRoot = deps.tmpRoot ?? '/tmp';
  const tmpDir = join(tmpRoot, `botsky-video-${job.id}`);
  const signal = AbortSignal.timeout(product.videoDownloadTimeoutMs);

  try {
    if (!(await transaction(db, c => mediaAllowed(c, config, job.chat_id, job.owner_id)))) {
      throw new Error('NOT_ALLOWED');
    }

    const payload = videoJobPayloadSchema.parse(job.payload);
    const canonicalUrl = payload.canonicalUrl ?? payload.url;
    if (!canonicalUrl) {
      throw new Error('VIDEO_DOWNLOAD_FAILED: missing_url');
    }

    await mkdir(tmpDir, { recursive: true, mode: 0o700 });

    const downloaded = await deps.download(canonicalUrl, tmpDir, {
      quality: payload.quality,
      mode: payload.mode,
      maxBytes: product.videoWhatsAppMaxBytes * 4,
      signal,
    });

    const isAudio = payload.mode === 'audio';
    const outputFileName = isAudio ? 'output.mp3' : 'output.mp4';
    const outputPath = join(tmpDir, outputFileName);

    let mime: string;
    let ext: string;
    let mediaKind: 'video' | 'audio';

    if (isAudio) {
      mime = 'audio/mpeg';
      ext = 'mp3';
      mediaKind = 'audio';
      if (downloaded.filePath !== outputPath) {
        await copyFile(downloaded.filePath, outputPath);
      }
      const st = await stat(outputPath);
      if (st.size > product.videoWhatsAppMaxBytes) {
        throw new Error('VIDEO_TOO_LARGE');
      }
    } else {
      mime = 'video/mp4';
      ext = 'mp4';
      mediaKind = 'video';
      await deps.transcode(downloaded.filePath, outputPath, {
        targetMaxBytes: product.videoWhatsAppMaxBytes,
        signal,
      });
    }

    const bytes = await readFile(outputPath);
    validateBytes(bytes, mime, product.videoWhatsAppMaxBytes);

    await transaction(db, async c => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1 FOR UPDATE', [job.id]))
        .rows[0];
      if (cur?.status !== 'running') return;
      if (!(await mediaAllowed(c, config, job.chat_id, job.owner_id))) {
        throw new Error('NOT_ALLOWED');
      }
      await capacity(c, bytes.length);

      const attachment = (
        await c.query<{ id: string }>(
          `INSERT INTO media_attachments(chat_id, owner_id, job_id, artifact_index, is_original, mime, extension, size, sha256, data, expires_at)
           VALUES($1, $2, $3, 0, false, $4, $5, $6, $7, $8, clock_timestamp() + $9::int * interval '1 day')
           ON CONFLICT(job_id, artifact_index, is_original)
           DO UPDATE SET data=excluded.data, size=excluded.size, sha256=excluded.sha256, expires_at=excluded.expires_at
           RETURNING id`,
          [job.chat_id, job.owner_id, job.id, mime, ext, bytes.length, digest(bytes), bytes, product.mediaGeneratedDays]
        )
      ).rows[0]!;

      const fileName = `botsky-video-${job.id}.${ext}`;
      const defaultText =
        config.ROUTER_MODE === 'v1_1'
          ? isAudio
            ? 'Listo, aquí tienes tu audio.'
            : 'Listo, aquí tienes tu video.'
          : `Resultado del trabajo #${job.id}.`;
      const caption = payload.title ? `${isAudio ? 'Audio' : 'Video'}: ${payload.title}` : defaultText;
      const finalText = config.ROUTER_MODE === 'v1_1' ? sanitizeOutputV2(caption) : caption;

      const outboxPayload = {
        text: finalText,
        sourceId: job.source_message_id,
        attachmentId: attachment.id,
        actorId: job.owner_id,
        jobId: job.id,
        mediaKind,
        fileName,
      };

      const outboxRow = (
        await c.query<{ id: string }>(
          `INSERT INTO outbox(chat_id, kind, payload, dedupe_key)
           VALUES($1, 'media_result', $2, $3)
           ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key
           RETURNING id`,
          [job.chat_id, JSON.stringify(outboxPayload), `video:result:${job.id}:0`]
        )
      ).rows[0]!;

      if (config.ROUTER_MODE === 'v1_1') {
        await registerArtifactV2(c, config.ROUTER_MODE, {
          chatId: job.chat_id,
          actorId: job.owner_id,
          sourceMessageId: job.source_message_id,
          mediaId: attachment.id,
          origin: 'bot_output',
          jobId: job.id,
          outboxId: outboxRow.id,
          filename: fileName,
          kind: mediaKind,
        });
      }

      await c.query(
        "UPDATE jobs SET status='done', outbox_id=$2, result=$3, updated_at=now() WHERE id=$1 AND status='running'",
        [job.id, outboxRow.id, JSON.stringify({ bytes: bytes.length, delivery: 'pending' })]
      );
      await c.query(
        "INSERT INTO audit_log(actor_id, chat_id, action, detail) VALUES($1, $2, 'video.processed', jsonb_build_object('jobId', $3::text, 'result', 'queued_for_delivery'))",
        [job.owner_id, job.chat_id, job.id]
      );
    });
  } catch (error: unknown) {
    observer.emit(() => ({ eventType: 'JOB_FAILED', stage: 'video.worker', payload: { error } }));
    const rawMsg = error instanceof Error ? error.message : String(error);
    let code = 'VIDEO_PROCESS_FAILED';
    if (/VIDEO_TOO_LARGE/i.test(rawMsg) || /size_limit/i.test(rawMsg)) {
      code = 'VIDEO_TOO_LARGE';
    } else if (
      /VIDEO_DOWNLOAD_TIMEOUT/i.test(rawMsg) ||
      /VIDEO_TRANSCODE_TIMEOUT/i.test(rawMsg) ||
      /timeout/i.test(rawMsg)
    ) {
      code = 'VIDEO_TIMEOUT';
    } else if (/VIDEO_DOWNLOAD_FAILED/i.test(rawMsg)) {
      code = 'VIDEO_DOWNLOAD_FAILED';
    } else if (/VIDEO_TRANSCODE_FAILED/i.test(rawMsg)) {
      code = 'VIDEO_TRANSCODE_FAILED';
    } else if (/NOT_ALLOWED/i.test(rawMsg) || /not_allowed/i.test(rawMsg)) {
      code = 'NOT_ALLOWED';
    }

    await transaction(db, async c => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1 FOR UPDATE', [job.id]))
        .rows[0];
      if (cur?.status !== 'running') return;
      const outboxId = await notifyVideo(c, job, videoFailure(code), config.ROUTER_MODE);
      await c.query(
        "UPDATE jobs SET status='failed', error=$2, outbox_id=$3, updated_at=now() WHERE id=$1 AND status='running'",
        [job.id, code, outboxId]
      );
      await c.query(
        "INSERT INTO audit_log(actor_id, chat_id, action, detail) VALUES($1, $2, 'video.failed', jsonb_build_object('jobId', $3::text, 'result', $4::text))",
        [job.owner_id, job.chat_id, job.id, code]
      );
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function processVideoJob(
  db: Db,
  config: Config,
  job: MediaJob,
  deps: VideoWorkerDeps = defaultDeps
): Promise<void> {
  return observer.source(
    {
      jobId: job.id,
      chatId: job.chat_id,
      actorId: job.owner_id,
      sourceMessageId: job.source_message_id,
      providerMsgId: job.source_message_id,
      routerMode: config.ROUTER_MODE,
    },
    async () => {
      const started = performance.now();
      observer.emit(() => ({ eventType: 'JOB_CLAIMED', stage: 'video.worker.claimed', payload: job }));
      observer.emit(() => ({ eventType: 'JOB_STARTED', stage: 'video.worker', payload: job }));
      try {
        await processVideoJobImpl(db, config, job, deps);
      } catch (error) {
        observer.emit(() => ({ eventType: 'JOB_FAILED', stage: 'video.worker.escape', payload: { error } }));
        throw error;
      } finally {
        observer.emit(() => ({
          eventType: 'JOB_OUTPUT',
          stage: 'video.worker.finished',
          payload: { latencyMs: performance.now() - started },
        }));
        await observer.snapshot('jobs', job.id, 'video.worker.persisted');
      }
    }
  );
}
