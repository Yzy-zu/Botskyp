import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { isSafeUrl, REDTUBE_DOMAINS } from './security.js';

interface RedTubeItem {
  video_id?: string | number;
  id?: string | number;
  title?: string;
  duration?: string | number;
  default_thumb?: string;
  thumb?: string;
  url?: string;
  author?: string;
  [key: string]: unknown;
}

interface RedTubeSearchResponse {
  videos?: Array<{ video?: RedTubeItem } | RedTubeItem>;
  count?: number;
  [key: string]: unknown;
}

interface RedTubeGetVideoResponse {
  video?: RedTubeItem;
  code?: number;
  message?: string;
  [key: string]: unknown;
}

export interface RedTubeProviderOptions {
  fetch?: typeof fetch | undefined;
  apiBaseUrl?: string | undefined;
}

export function parseRedTubeDuration(duration: unknown): number | undefined {
  if (typeof duration === 'number' && duration >= 0) {
    return Math.round(duration);
  }
  if (typeof duration === 'string') {
    const trimmed = duration.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    const parts = trimmed.split(':').map(Number);
    if (parts.length === 2 && parts.every(n => !isNaN(n) && n >= 0)) {
      return parts[0]! * 60 + parts[1]!;
    }
    if (parts.length === 3 && parts.every(n => !isNaN(n) && n >= 0)) {
      return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
  }
  return undefined;
}

export class RedTubeProvider implements VideoProvider {
  readonly id = 'redtube' as const;
  readonly isAdult = true;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: true,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options?: RedTubeProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.apiBaseUrl = options?.apiBaseUrl ?? 'https://api.redtube.com';
  }

  isUrlAllowed(url: string): boolean {
    if (!isSafeUrl(url, REDTUBE_DOMAINS)) return false;
    try {
      const parsed = new URL(url);
      return /\/\d+/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  extractId(urlOrId: string): string | undefined {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const match = /\/(\d+)(?:\/|$|\?)/.exec(parsed.pathname);
      if (match?.[1]) return match[1];
    } catch {
      // Not a URL
    }

    return undefined;
  }

  async search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]> {
    options?.signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const url = `${this.apiBaseUrl}/?data=redtube.Videos.searchVideos&output=json&search=${encodeURIComponent(cleanQuery)}`;

    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as RedTubeSearchResponse;
    const rawList = Array.isArray(data.videos) ? data.videos : [];

    const results: NormalizedVideoResult[] = [];
    for (const entry of rawList) {
      const item: RedTubeItem =
        typeof entry === 'object' && entry !== null && 'video' in entry && entry.video
          ? (entry.video as RedTubeItem)
          : (entry as RedTubeItem);

      const rawId = item.video_id ?? item.id;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') continue;

      results.push(this.normalizeItem(item, String(rawId)));
      if (results.length >= limit) break;
    }

    return results;
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const id = this.extractId(urlOrId);
    if (!id) return undefined;

    const url = `${this.apiBaseUrl}/?data=redtube.Videos.getVideoById&output=json&video_id=${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return undefined;
    }

    const data = (await res.json()) as RedTubeGetVideoResponse;
    if (!data.video) {
      return undefined;
    }

    const rawId = data.video.video_id ?? data.video.id ?? id;
    return this.normalizeItem(data.video, String(rawId));
  }

  private normalizeItem(item: RedTubeItem, id: string): NormalizedVideoResult {
    const title = typeof item.title === 'string' ? item.title : '';
    const durationSeconds = parseRedTubeDuration(item.duration);
    const uploader = typeof item.author === 'string' ? item.author : undefined;
    const thumbnailUrl =
      typeof item.default_thumb === 'string' && item.default_thumb
        ? item.default_thumb
        : typeof item.thumb === 'string' && item.thumb
          ? item.thumb
          : undefined;
    const webpageUrl = `https://www.redtube.com/${id}`;

    return {
      provider: this.id,
      id,
      title,
      webpageUrl,
      downloadable: true,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(uploader !== undefined ? { uploader } : {}),
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      metadata: item,
    };
  }
}
