import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { execFile as nodeExecFile, ChildProcess } from 'node:child_process';
import { downloadVideo } from '../src/modules/video/downloader.js';
import { probeMedia, transcodeForWhatsApp } from '../src/modules/video/transcoder.js';
import {
  processVideoJob,
  claimVideoJob,
  recoverVideoJobs,
  cleanOrphanVideoTemporaries,
  type VideoWorkerDeps,
} from '../src/modules/video/worker.js';
import { db, config, initialize, resetSchool } from './school-harness.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

// Valid MP4 header (ftyp) so validateBytes succeeds
const fakeMp4Bytes = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]), // size: 32
  Buffer.from('ftypisom', 'utf8'),        // ftyp major_brand: isom
  Buffer.from([0x00, 0x00, 0x02, 0x00]), // minor_version
  Buffer.from('isomiso2avc1mp41', 'utf8'),// compatible_brands
  Buffer.alloc(1024, 0xaa),              // dummy payload
]);

describe('Video Pipeline', () => {
  let testRoot: string;

  beforeAll(async () => {
    await initialize();
    testRoot = await mkdtemp(join(tmpdir(), 'botsky-vpipe-test-'));
  });

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await db.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetSchool();
    await db.query('TRUNCATE media_attachments,jobs CASCADE');
  });

  describe('Downloader (downloader.ts)', () => {
    it('successfully downloads a video with proper yt-dlp arguments', async () => {
      const targetDir = join(testRoot, 'dl-success');
      await mkdir(targetDir, { recursive: true });

      let capturedArgs: string[] = [];
      const mockExec: typeof nodeExecFile = vi.fn((_file, args, options, callback) => {
        const argList = (args as string[]) ?? [];
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        if (argList.includes('-print_format')) {
          cb(null, JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', duration: '15.0' }],
            format: { duration: '15.0', size: String(fakeMp4Bytes.length) },
          }), '');
        } else {
          capturedArgs = argList;
          const outPath = join(targetDir, 'video.mp4');
          void writeFile(outPath, fakeMp4Bytes).then(() => {
            cb(null, outPath + '\n', '');
          });
        }
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      const res = await downloadVideo('https://example.com/watch?v=12345', targetDir, {
        quality: '720p',
        maxBytes: 16_000_000,
        execFileImpl: mockExec,
      });

      expect(res.filePath).toBe(join(targetDir, 'video.mp4'));
      expect(res.format).toBe('mp4');
      expect(res.sizeBytes).toBe(fakeMp4Bytes.length);

      // Verify security flags & parameters
      expect(capturedArgs).toContain('--no-playlist');
      expect(capturedArgs).toContain('--no-warnings');
      expect(capturedArgs).toContain('--no-call-home');
      expect(capturedArgs).toContain('--no-check-certificates');
      expect(capturedArgs).toContain('--merge-output-format');
      expect(capturedArgs).toContain('mp4');
      expect(capturedArgs).toContain('--max-filesize');
      expect(capturedArgs).toContain('16000000');
      expect(capturedArgs.some(a => a.includes('height<=720'))).toBe(true);
      expect(capturedArgs).toContain('https://example.com/watch?v=12345');
    });

    it('passes audio extraction flags when mode is audio', async () => {
      const targetDir = join(testRoot, 'dl-audio');
      await mkdir(targetDir, { recursive: true });

      let capturedArgs: string[] = [];
      const mockExec: typeof nodeExecFile = vi.fn((_file, args, options, callback) => {
        const argList = (args as string[]) ?? [];
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        if (argList.includes('-print_format')) {
          cb(null, JSON.stringify({
            streams: [{ codec_type: 'audio', codec_name: 'mp3', duration: '20.0' }],
            format: { duration: '20.0', size: '100' },
          }), '');
        } else {
          capturedArgs = argList;
          const outPath = join(targetDir, 'video.mp3');
          void writeFile(outPath, Buffer.from('ID3fake-mp3-bytes')).then(() => {
            cb(null, outPath + '\n', '');
          });
        }
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      const res = await downloadVideo('https://example.com/audio/test', targetDir, {
        mode: 'audio',
        execFileImpl: mockExec,
      });

      expect(res.filePath).toBe(join(targetDir, 'video.mp3'));
      expect(res.format).toBe('mp3');
      expect(capturedArgs).toContain('--extract-audio');
      expect(capturedArgs).toContain('--audio-format');
      expect(capturedArgs).toContain('mp3');
    });

    it('fails with VIDEO_TOO_LARGE when yt-dlp reports file is larger than max-filesize', async () => {
      const targetDir = join(testRoot, 'dl-too-large-ytdlp');
      await mkdir(targetDir, { recursive: true });

      const mockExec: typeof nodeExecFile = vi.fn((_file, _args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        const err = new Error('Command failed: yt-dlp');
        cb(err, '', 'ERROR: File is larger than max-filesize (16000000 bytes)');
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      await expect(
        downloadVideo('https://example.com/video/huge', targetDir, {
          maxBytes: 16_000_000,
          execFileImpl: mockExec,
        })
      ).rejects.toThrow('VIDEO_TOO_LARGE');
    });

    it('fails with VIDEO_TOO_LARGE and deletes file if file on disk exceeds maxBytes', async () => {
      const targetDir = join(testRoot, 'dl-too-large-disk');
      await mkdir(targetDir, { recursive: true });

      const mockExec: typeof nodeExecFile = vi.fn((_file, _args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        const outPath = join(targetDir, 'video.mp4');
        const bigBytes = Buffer.alloc(2000, 0x11);
        void writeFile(outPath, bigBytes).then(() => {
          cb(null, outPath + '\n', '');
        });
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      await expect(
        downloadVideo('https://example.com/video/big', targetDir, {
          maxBytes: 1000,
          execFileImpl: mockExec,
        })
      ).rejects.toThrow('VIDEO_TOO_LARGE');

      expect(existsSync(join(targetDir, 'video.mp4'))).toBe(false);
    });

    it('rejects unsafe SSRF URLs before invoking yt-dlp', async () => {
      const targetDir = join(testRoot, 'dl-unsafe');
      await mkdir(targetDir, { recursive: true });

      const mockExec: typeof nodeExecFile = vi.fn() as unknown as typeof nodeExecFile;

      await expect(
        downloadVideo('http://127.0.0.1/private.mp4', targetDir, { execFileImpl: mockExec })
      ).rejects.toThrow();

      await expect(
        downloadVideo('http://169.254.169.254/latest/meta-data', targetDir, { execFileImpl: mockExec })
      ).rejects.toThrow();

      await expect(
        downloadVideo('file:///etc/passwd', targetDir, { execFileImpl: mockExec })
      ).rejects.toThrow();

      expect(mockExec).not.toHaveBeenCalled();
    });

    it('handles download timeout with AbortSignal', async () => {
      const targetDir = join(testRoot, 'dl-timeout');
      await mkdir(targetDir, { recursive: true });

      const controller = new AbortController();
      controller.abort();

      await expect(
        downloadVideo('https://example.com/video/timeout', targetDir, { signal: controller.signal })
      ).rejects.toThrow('VIDEO_DOWNLOAD_TIMEOUT');
    });
  });

  describe('Transcoder (transcoder.ts)', () => {
    it('probeMedia parses ffprobe json output correctly', async () => {
      const testFile = join(testRoot, 'test-probe.mp4');
      await writeFile(testFile, fakeMp4Bytes);

      const probeJson = {
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '45.5' },
          { codec_type: 'audio', codec_name: 'aac', duration: '45.5' },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp',
          duration: '45.5',
          size: String(fakeMp4Bytes.length),
        },
      };

      const mockExec: typeof nodeExecFile = vi.fn((_file, _args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        cb(null, JSON.stringify(probeJson), '');
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      const res = await probeMedia(testFile, { execFileImpl: mockExec });
      expect(res.durationSeconds).toBe(45.5);
      expect(res.width).toBe(1920);
      expect(res.height).toBe(1080);
      expect(res.vcodec).toBe('h264');
      expect(res.acodec).toBe('aac');
      expect(res.sizeBytes).toBe(fakeMp4Bytes.length);
    });

    it('skips transcode when video is already compliant MP4 (H264/AAC, <=16MB)', async () => {
      const inputPath = join(testRoot, 'already-good.mp4');
      const outputPath = join(testRoot, 'already-good-out.mp4');
      await writeFile(inputPath, fakeMp4Bytes);

      const probeJson = {
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '30.0' },
          { codec_type: 'audio', codec_name: 'aac', duration: '30.0' },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp',
          duration: '30.0',
          size: String(fakeMp4Bytes.length),
        },
      };

      let ffmpegCalled = false;
      const mockExec: typeof nodeExecFile = vi.fn((file, _args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        if (String(file).includes('ffprobe')) {
          cb(null, JSON.stringify(probeJson), '');
        } else {
          ffmpegCalled = true;
          cb(null, '', '');
        }
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      const res = await transcodeForWhatsApp(inputPath, outputPath, {
        targetMaxBytes: 16_000_000,
        execFileImpl: mockExec,
      });
      expect(ffmpegCalled).toBe(false);
      expect(res.sizeBytes).toBe(fakeMp4Bytes.length);
      expect(existsSync(outputPath)).toBe(true);
    });

    it('transcodes when input has non-compliant codec (e.g. vp9)', async () => {
      const inputPath = join(testRoot, 'needs-transcode.webm');
      const outputPath = join(testRoot, 'transcoded.mp4');
      await writeFile(inputPath, Buffer.from('fake-webm-data'));

      const probeJson = {
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, duration: '30.0' },
          { codec_type: 'audio', codec_name: 'opus', duration: '30.0' },
        ],
        format: {
          format_name: 'matroska,webm',
          duration: '30.0',
          size: '1000',
        },
      };

      let capturedFfmpegArgs: string[] = [];
      const mockExec: typeof nodeExecFile = vi.fn((file, args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        if (String(file).includes('ffprobe') || (args as string[]).includes('-print_format')) {
          cb(null, JSON.stringify(probeJson), '');
        } else {
          capturedFfmpegArgs = (args as string[]) ?? [];
          void writeFile(outputPath, fakeMp4Bytes).then(() => {
            cb(null, '', '');
          });
        }
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      const res = await transcodeForWhatsApp(inputPath, outputPath, {
        targetMaxBytes: 16_000_000,
        execFileImpl: mockExec,
      });
      expect(res.sizeBytes).toBe(fakeMp4Bytes.length);
      expect(capturedFfmpegArgs).toContain('-c:v');
      expect(capturedFfmpegArgs).toContain('libx264');
      expect(capturedFfmpegArgs).toContain('-pix_fmt');
      expect(capturedFfmpegArgs).toContain('yuv420p');
      expect(capturedFfmpegArgs).toContain('-c:a');
      expect(capturedFfmpegArgs).toContain('aac');
      expect(capturedFfmpegArgs).toContain('+faststart');
    });

    it('fails with VIDEO_TOO_LARGE when duration is too long to compress into 16MB', async () => {
      const inputPath = join(testRoot, 'too-long.mp4');
      const outputPath = join(testRoot, 'too-long-out.mp4');
      await writeFile(inputPath, Buffer.from('dummy'));

      const probeJson = {
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, duration: '3600.0' },
        ],
        format: {
          format_name: 'matroska,webm',
          duration: '3600.0',
          size: '100000000',
        },
      };

      const mockExec: typeof nodeExecFile = vi.fn((_file, _args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        cb(null, JSON.stringify(probeJson), '');
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      await expect(
        transcodeForWhatsApp(inputPath, outputPath, {
          targetMaxBytes: 16_000_000,
          execFileImpl: mockExec,
        })
      ).rejects.toThrow('VIDEO_TOO_LARGE');
    });

    it('fails with VIDEO_TOO_LARGE and removes output if transcode exceeds targetMaxBytes', async () => {
      const inputPath = join(testRoot, 'output-overflow.mp4');
      const outputPath = join(testRoot, 'overflow-out.mp4');
      await writeFile(inputPath, Buffer.from('dummy'));

      const probeJson = {
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, duration: '120.0' },
        ],
        format: {
          format_name: 'matroska,webm',
          duration: '120.0',
          size: '50000000',
        },
      };

      const mockExec: typeof nodeExecFile = vi.fn((file, args, options, callback) => {
        const cb = (typeof options === 'function' ? options : callback) as unknown as ExecCallback;
        if (String(file).includes('ffprobe') || (args as string[]).includes('-print_format')) {
          cb(null, JSON.stringify(probeJson), '');
        } else {
          // Write an oversized output file
          void writeFile(outputPath, Buffer.alloc(17_000_000, 0x11)).then(() => {
            cb(null, '', '');
          });
        }
        return {} as unknown as ChildProcess;
      }) as unknown as typeof nodeExecFile;

      await expect(
        transcodeForWhatsApp(inputPath, outputPath, {
          targetMaxBytes: 16_000_000,
          execFileImpl: mockExec,
        })
      ).rejects.toThrow('VIDEO_TOO_LARGE');

      expect(existsSync(outputPath)).toBe(false);
    });
  });

  describe('Worker Pipeline (worker.ts)', () => {
    it('executes full video pipeline: downloads, transcodes, saves attachment and queues delivery', async () => {
      const jobRow = (
        await db.query<{ id: string }>(
          `INSERT INTO jobs(kind, status, payload, chat_id, owner_id, source_message_id)
           VALUES('video_download', 'queued', $1, $2, $3, 'msg-101') RETURNING id`,
          [
            JSON.stringify({ canonicalUrl: 'https://example.com/video/test1', title: 'Mi Video Test' }),
            config.LAB_CHAT_ID,
            config.OWNER_JIDS[0],
          ]
        )
      ).rows[0]!;

      const claimed = await claimVideoJob(db);
      expect(claimed).toBeDefined();
      expect(claimed!.id).toBe(jobRow.id);

      const mockDeps: VideoWorkerDeps = {
        download: vi.fn(async (_url, targetDir) => {
          const filePath = join(targetDir, 'downloaded.mp4');
          await writeFile(filePath, fakeMp4Bytes);
          return { filePath, format: 'mp4', sizeBytes: fakeMp4Bytes.length, durationSeconds: 30 };
        }),
        transcode: vi.fn(async (_input, output) => {
          await writeFile(output, fakeMp4Bytes);
          return { sizeBytes: fakeMp4Bytes.length };
        }),
        probe: vi.fn(async () => ({
          durationSeconds: 30,
          vcodec: 'h264',
          acodec: 'aac',
          sizeBytes: fakeMp4Bytes.length,
        })),
        tmpRoot: testRoot,
      };

      await processVideoJob(db, config, claimed!, mockDeps);

      // Verify job is marked 'done'
      const updatedJob = (await db.query<{ status: string; outbox_id: string }>('SELECT status, outbox_id FROM jobs WHERE id=$1', [claimed!.id])).rows[0]!;
      expect(updatedJob.status).toBe('done');
      expect(updatedJob.outbox_id).toBeDefined();

      // Verify attachment was registered
      const attachment = (await db.query<{ id: string; mime: string; size: string; is_original: boolean }>('SELECT * FROM media_attachments WHERE job_id=$1', [claimed!.id])).rows[0]!;
      expect(attachment.mime).toBe('video/mp4');
      expect(Number(attachment.size)).toBe(fakeMp4Bytes.length);
      expect(attachment.is_original).toBe(false);

      // Verify outbox record
      const outboxRow = (await db.query<{ kind: string; payload: { text: string; mediaKind?: string; attachmentId?: string } }>('SELECT kind, payload FROM outbox WHERE id=$1', [updatedJob.outbox_id])).rows[0]!;
      expect(outboxRow.kind).toBe('media_result');
      expect(outboxRow.payload.mediaKind).toBe('video');
      expect(outboxRow.payload.attachmentId).toBe(attachment.id);
      expect(outboxRow.payload.text).toContain('Mi Video Test');

      // Verify temporary directory cleanup
      const tmpDir = join(testRoot, `botsky-video-${claimed!.id}`);
      expect(existsSync(tmpDir)).toBe(false);
    });

    it('handles VIDEO_TOO_LARGE failure deterministically and notifies user in outbox', async () => {
      await db.query<{ id: string }>(
        `INSERT INTO jobs(kind, status, payload, chat_id, owner_id, source_message_id)
         VALUES('video_download', 'queued', $1, $2, $3, 'msg-102') RETURNING id`,
        [
          JSON.stringify({ canonicalUrl: 'https://example.com/video/huge' }),
          config.LAB_CHAT_ID,
          config.OWNER_JIDS[0],
        ]
      );

      const claimed = await claimVideoJob(db);
      expect(claimed).toBeDefined();

      const mockDeps: VideoWorkerDeps = {
        download: vi.fn(async () => {
          throw new Error('VIDEO_TOO_LARGE');
        }),
        transcode: vi.fn(),
        probe: vi.fn(),
        tmpRoot: testRoot,
      };

      await processVideoJob(db, config, claimed!, mockDeps);

      // Job should be marked failed
      const updatedJob = (await db.query<{ status: string; error: string; outbox_id: string }>('SELECT status, error, outbox_id FROM jobs WHERE id=$1', [claimed!.id])).rows[0]!;
      expect(updatedJob.status).toBe('failed');
      expect(updatedJob.error).toBe('VIDEO_TOO_LARGE');

      // User notified with clear message
      const outboxRow = (await db.query<{ payload: { text: string; mediaKind?: string; attachmentId?: string } }>('SELECT payload FROM outbox WHERE id=$1', [updatedJob.outbox_id])).rows[0]!;
      expect(outboxRow.payload.text).toContain('demasiado grande o largo');

      // Temp directory must be cleaned up
      const tmpDir = join(testRoot, `botsky-video-${claimed!.id}`);
      expect(existsSync(tmpDir)).toBe(false);
    });

    it('handles VIDEO_DOWNLOAD_FAILED deterministically and notifies user', async () => {
      await db.query<{ id: string }>(
        `INSERT INTO jobs(kind, status, payload, chat_id, owner_id, source_message_id)
         VALUES('video_download', 'queued', $1, $2, $3, 'msg-103') RETURNING id`,
        [
          JSON.stringify({ canonicalUrl: 'https://example.com/video/broken' }),
          config.LAB_CHAT_ID,
          config.OWNER_JIDS[0],
        ]
      );

      const claimed = await claimVideoJob(db);
      const mockDeps: VideoWorkerDeps = {
        download: vi.fn(async () => {
          throw new Error('VIDEO_DOWNLOAD_FAILED: 404 Not Found');
        }),
        transcode: vi.fn(),
        probe: vi.fn(),
        tmpRoot: testRoot,
      };

      await processVideoJob(db, config, claimed!, mockDeps);

      const updatedJob = (await db.query<{ status: string; error: string; outbox_id: string }>('SELECT status, error, outbox_id FROM jobs WHERE id=$1', [claimed!.id])).rows[0]!;
      expect(updatedJob.status).toBe('failed');
      expect(updatedJob.error).toBe('VIDEO_DOWNLOAD_FAILED');

      const outboxRow = (await db.query<{ payload: { text: string; mediaKind?: string; attachmentId?: string } }>('SELECT payload FROM outbox WHERE id=$1', [updatedJob.outbox_id])).rows[0]!;
      expect(outboxRow.payload.text).toContain('No pude descargar el video');
    });

    it('recovers running video jobs on startup', async () => {
      const jobRow = (
        await db.query<{ id: string }>(
          `INSERT INTO jobs(kind, status, payload, chat_id, owner_id, source_message_id, attempts)
           VALUES('video_download', 'running', $1, $2, $3, 'msg-104', 1) RETURNING id`,
          [
            JSON.stringify({ canonicalUrl: 'https://example.com/video/interrupted' }),
            config.LAB_CHAT_ID,
            config.OWNER_JIDS[0],
          ]
        )
      ).rows[0]!;

      await recoverVideoJobs(db, config);

      const recovered = (await db.query<{ status: string; error: string }>('SELECT status, error FROM jobs WHERE id=$1', [jobRow.id])).rows[0]!;
      expect(recovered.status).toBe('queued');
      expect(recovered.error).toBe('interrupted');
    });

    it('recovers running video jobs exceeding max attempts as failed with notice', async () => {
      const jobRow = (
        await db.query<{ id: string }>(
          `INSERT INTO jobs(kind, status, payload, chat_id, owner_id, source_message_id, attempts)
           VALUES('video_download', 'running', $1, $2, $3, 'msg-105', 3) RETURNING id`,
          [
            JSON.stringify({ canonicalUrl: 'https://example.com/video/interrupted-max' }),
            config.LAB_CHAT_ID,
            config.OWNER_JIDS[0],
          ]
        )
      ).rows[0]!;

      await recoverVideoJobs(db, config);

      const recovered = (await db.query<{ status: string; error: string; outbox_id: string }>('SELECT status, error, outbox_id FROM jobs WHERE id=$1', [jobRow.id])).rows[0]!;
      expect(recovered.status).toBe('failed');
      expect(recovered.error).toBe('interrupted');
      expect(recovered.outbox_id).toBeDefined();

      const outboxRow = (await db.query<{ payload: { text: string; mediaKind?: string; attachmentId?: string } }>('SELECT payload FROM outbox WHERE id=$1', [recovered.outbox_id])).rows[0]!;
      expect(outboxRow.payload.text).toContain('interrumpido');
    });

    it('cleanOrphanVideoTemporaries removes leftover botsky-video directories', async () => {
      const orphanDir = join(testRoot, 'botsky-video-orphan123');
      await mkdir(orphanDir, { recursive: true });
      await writeFile(join(orphanDir, 'leftover.part'), 'junk');

      expect(existsSync(orphanDir)).toBe(true);
      await cleanOrphanVideoTemporaries(testRoot);
      expect(existsSync(orphanDir)).toBe(false);
    });
  });
});
