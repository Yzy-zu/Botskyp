import { execFile } from 'node:child_process';
import { stat, copyFile, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { product } from '../../../config/product.js';

export interface MediaProbeResult {
  durationSeconds: number;
  width?: number | undefined;
  height?: number | undefined;
  vcodec?: string | undefined;
  acodec?: string | undefined;
  sizeBytes: number;
}

export interface TranscodeOptions {
  targetMaxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  ffmpegBinary?: string | undefined;
  ffprobeBinary?: string | undefined;
  execFileImpl?: typeof execFile | undefined;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
  size?: string;
  format_name?: string;
}

interface FfprobeData {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * Probes media file metadata using ffprobe.
 */
export async function probeMedia(
  filePath: string,
  options?: { binaryPath?: string | undefined; signal?: AbortSignal | undefined; execFileImpl?: typeof execFile | undefined }
): Promise<MediaProbeResult> {
  const binary = options?.binaryPath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const runExecFile = options?.execFileImpl ?? execFile;
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];

  const rawJson = await new Promise<string>((resolve, reject) => {
    runExecFile(binary, args, { ...(options?.signal ? { signal: options.signal } : {}), maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ? String(stdout) : '');
    });
  });

  let data: FfprobeData;
  try {
    data = JSON.parse(rawJson) as FfprobeData;
  } catch (err) {
    throw new Error(`FFPROBE_FAILED: Failed to parse probe output (${err instanceof Error ? err.message : String(err)})`);
  }

  const streams = data.streams ?? [];
  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');

  const durStr = videoStream?.duration ?? audioStream?.duration ?? data.format?.duration ?? '0';
  const durationSeconds = Number.isFinite(parseFloat(durStr)) ? parseFloat(durStr) : 0;

  const width = videoStream?.width ? Number(videoStream.width) : undefined;
  const height = videoStream?.height ? Number(videoStream.height) : undefined;
  const vcodec = videoStream?.codec_name ? String(videoStream.codec_name).toLowerCase() : undefined;
  const acodec = audioStream?.codec_name ? String(audioStream.codec_name).toLowerCase() : undefined;

  let sizeBytes = 0;
  try {
    const st = await stat(filePath);
    sizeBytes = st.size;
  } catch {
    sizeBytes = data.format?.size ? Number(data.format.size) : 0;
  }

  return {
    durationSeconds,
    width,
    height,
    vcodec,
    acodec,
    sizeBytes,
  };
}

/**
 * Transcodes media to WhatsApp-compliant MP4 (H.264/AAC, <= targetMaxBytes).
 * If already compliant and under targetMaxBytes, transcode is skipped.
 */
export async function transcodeForWhatsApp(
  inputPath: string,
  outputPath: string,
  options: TranscodeOptions = {}
): Promise<{ sizeBytes: number }> {
  const targetMaxBytes = options.targetMaxBytes ?? product.videoWhatsAppMaxBytes;
  const probe = await probeMedia(inputPath, { binaryPath: options.ffprobeBinary, signal: options.signal, execFileImpl: options.execFileImpl });

  // If already MP4 with h264 and aac (or silent) and size <= targetMaxBytes, avoid transcoding
  const isMp4Ext = extname(inputPath).toLowerCase() === '.mp4';
  const isH264 = probe.vcodec === 'h264';
  const isAacOrNone = probe.acodec === 'aac' || !probe.acodec;
  const isUnderSize = probe.sizeBytes <= targetMaxBytes;

  if (isMp4Ext && isH264 && isAacOrNone && isUnderSize) {
    if (inputPath !== outputPath) {
      await copyFile(inputPath, outputPath);
    }
    return { sizeBytes: probe.sizeBytes };
  }

  // Duration must be compressible into targetMaxBytes
  const duration = Math.max(1, probe.durationSeconds);
  const usableBytes = targetMaxBytes * 0.92; // Reserve 8% container/muxing overhead
  const totalBitrate = Math.floor((usableBytes * 8) / duration);

  // If duration is too long for target size, fail conservatively
  if (totalBitrate < 120_000) {
    throw new Error('VIDEO_TOO_LARGE');
  }

  let audioBitrate = 0;
  if (probe.acodec) {
    if (totalBitrate < 400_000) {
      audioBitrate = 48_000;
    } else if (totalBitrate < 800_000) {
      audioBitrate = 64_000;
    } else {
      audioBitrate = 96_000;
    }
  }

  const videoBitrate = Math.max(80_000, totalBitrate - audioBitrate);

  // Resolution scaling based on bitrate budget and original height
  let scaleFilter: string;
  if (totalBitrate < 400_000) {
    scaleFilter = 'scale=-2:360';
  } else if (totalBitrate < 800_000) {
    scaleFilter = 'scale=-2:480';
  } else if (probe.height && probe.height > 720) {
    scaleFilter = 'scale=-2:720';
  } else {
    scaleFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  }

  const crf = totalBitrate < 800_000 ? '28' : '26';
  const binary = options.ffmpegBinary ?? process.env.FFMPEG_PATH ?? 'ffmpeg';

  const args: string[] = [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', crf,
    '-maxrate', String(videoBitrate),
    '-bufsize', String(videoBitrate * 2),
    '-pix_fmt', 'yuv420p',
    '-vf', scaleFilter,
  ];

  if (probe.acodec) {
    args.push('-c:a', 'aac', '-b:a', String(audioBitrate));
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', outputPath);

  const runExecFile = options.execFileImpl ?? execFile;
  try {
    await new Promise<void>((resolve, reject) => {
      runExecFile(binary, args, { ...(options.signal ? { signal: options.signal } : {}), maxBuffer: 10 * 1024 * 1024 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err: unknown) {
    await rm(outputPath, { force: true }).catch(() => {});
    if (options.signal?.aborted) {
      throw new Error('VIDEO_TRANSCODE_TIMEOUT');
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`VIDEO_TRANSCODE_FAILED: ${msg}`);
  }

  const finalStat = await stat(outputPath);
  if (finalStat.size > targetMaxBytes) {
    await rm(outputPath, { force: true });
    throw new Error('VIDEO_TOO_LARGE');
  }

  return { sizeBytes: finalStat.size };
}
