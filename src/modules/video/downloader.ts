import { execFile } from 'node:child_process';
import { stat, readdir, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { product } from '../../../config/product.js';
import { assertSafeUrl } from './providers/security.js';
import { probeMedia } from './transcoder.js';

export interface DownloadVideoOptions {
  quality?: string | undefined;
  mode?: 'video' | 'audio' | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  binaryPath?: string | undefined;
  execFileImpl?: typeof execFile | undefined;
}

export interface DownloadVideoResult {
  filePath: string;
  format: string;
  sizeBytes: number;
  durationSeconds?: number | undefined;
}

/**
 * Downloads video or audio using yt-dlp with strict parameterization (never shell: true).
 */
export async function downloadVideo(
  canonicalUrl: string,
  targetDir: string,
  options: DownloadVideoOptions = {}
): Promise<DownloadVideoResult> {
  assertSafeUrl(canonicalUrl);

  const maxBytes = options.maxBytes ?? product.videoMaxDownloadBytes;
  const timeoutMs = options.timeoutMs ?? product.videoDownloadTimeoutMs;
  const binary = options.binaryPath ?? process.env.YT_DLP_PATH ?? 'yt-dlp';

  const outputPattern = join(targetDir, 'video.%(ext)s');
  const args: string[] = [
    '--no-playlist',
    '--no-warnings',
    '--no-call-home',
    '--no-check-certificates',
    '--no-progress',
    '--max-filesize', String(maxBytes),
    '-o', outputPattern,
    '--print', 'after_move:filepath',
  ];

  if (options.mode === 'audio') {
    args.push('--extract-audio', '--audio-format', 'mp3', '--format', 'bestaudio/best');
  } else {
    args.push('--merge-output-format', 'mp4');
    if (options.quality) {
      const q = options.quality.trim();
      if (/^\d+p?$/i.test(q)) {
        const height = q.replace(/p$/i, '');
        args.push('--format', `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]/best`);
      } else {
        args.push('--format', q);
      }
    } else {
      args.push('--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    }
  }

  args.push(canonicalUrl);

  const controller = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutTimer);
      throw new Error('VIDEO_DOWNLOAD_TIMEOUT');
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const runExecFile = options.execFileImpl ?? execFile;
  let stdout = '';
  try {
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      runExecFile(
        binary,
        args,
        {
          signal: controller.signal,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, out, errOut) => {
          if (err) {
            const errWithDetails = Object.assign(err, {
              stderr: errOut ? String(errOut) : '',
              stdout: out ? String(out) : '',
            });
            reject(errWithDetails);
          } else {
            resolve({
              stdout: out ? String(out) : '',
            });
          }
        }
      );
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    clearTimeout(timeoutTimer);
    const errMessage = err instanceof Error ? err.message : String(err);
    const errStderr = typeof (err as { stderr?: unknown })?.stderr === 'string' ? (err as { stderr: string }).stderr : '';
    if (timedOut || controller.signal.aborted) {
      throw new Error('VIDEO_DOWNLOAD_TIMEOUT');
    }
    if (
      /larger than max-filesize/i.test(errMessage) ||
      /larger than max-filesize/i.test(errStderr) ||
      /File is larger than/i.test(errMessage) ||
      /File is larger than/i.test(errStderr)
    ) {
      throw new Error('VIDEO_TOO_LARGE');
    }
    throw new Error(`VIDEO_DOWNLOAD_FAILED: ${errMessage}`);
  } finally {
    clearTimeout(timeoutTimer);
  }

  const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
  let filePath: string | undefined = lines.length > 0 ? lines[lines.length - 1] : undefined;

  if (!filePath || !existsSync(filePath)) {
    const entries = await readdir(targetDir);
    const valid = entries.filter(e => !e.endsWith('.part') && !e.endsWith('.ytdl') && !e.endsWith('.temp'));
    if (valid.length > 0) {
      const videoMatch = valid.find(e => e.startsWith('video.'));
      filePath = join(targetDir, videoMatch ?? valid[0]!);
    }
  }

  if (!filePath || !existsSync(filePath)) {
    throw new Error('VIDEO_DOWNLOAD_FAILED: No downloaded media file found');
  }

  const st = await stat(filePath);
  if (maxBytes && st.size > maxBytes) {
    await rm(filePath, { force: true });
    throw new Error('VIDEO_TOO_LARGE');
  }

  const format = extname(filePath).replace(/^\./, '').toLowerCase();

  let durationSeconds: number | undefined;
  try {
    const probe = await probeMedia(filePath, { execFileImpl: options.execFileImpl });
    durationSeconds = probe.durationSeconds;
  } catch {
    // If probe fails (e.g. ffprobe mock or missing), leave undefined
  }

  return {
    filePath,
    format,
    sizeBytes: st.size,
    durationSeconds,
  };
}
