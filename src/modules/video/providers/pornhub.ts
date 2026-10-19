import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { isSafeUrl, PORNHUB_DOMAINS } from './security.js';

interface PornhubItem {
  video_id?: string;
  title?: string;
  duration?: string | number;
  url?: string;
  default_thumb?: string;
  thumb?: string;
  author?: string;
  pornstars?: Array<{ pornstar_name?: string }>;
  [key: string]: unknown;
}

interface PornhubSearchResponse {
  videos?: PornhubItem[];
  [key: string]: unknown;
}

interface PornhubGetVideoResponse {
  video?: PornhubItem;
  code?: number;
  message?: string;
  [key: string]: unknown;
}

export interface PornhubProviderOptions {
  fetch?: typeof fetch | undefined;
  apiBaseUrl?: string | undefined;
}

export function parsePornhubDuration(duration: unknown): number | undefined {
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

export class PornhubProvider implements VideoProvider {
  readonly id = 'pornhub' as const;
  readonly isAdult = true;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: true,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options?: PornhubProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.apiBaseUrl = options?.apiBaseUrl ?? 'https://www.pornhub.com/webmasters';
  }

  isUrlAllowed(url: string): boolean {
    if (!isSafeUrl(url, PORNHUB_DOMAINS)) return false;
    try {
      const parsed = new URL(url);
      return parsed.searchParams.has('viewkey') || parsed.pathname.includes('/view_video.php');
    } catch {
      return false;
    }
  }

  extractId(urlOrId: string): string | undefined {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    // Direct viewkey or id check (alphanumeric, often starts with ph or hex)
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && !trimmed.includes('.') && !trimmed.includes('/')) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const viewkey = parsed.searchParams.get('viewkey');
      if (viewkey && /^[a-zA-Z0-9_-]+$/.test(viewkey)) {
        return viewkey;
      }
    } catch {
      // Not a URL
    }

    const match = /viewkey=([a-zA-Z0-9_-]+)/i.exec(trimmed);
    if (match?.[1]) return match[1];

    return undefined;
  }

  async search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]> {
    options?.signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const url = `${this.apiBaseUrl}/search?search=${encodeURIComponent(cleanQuery)}`;

    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as PornhubSearchResponse;
    const items = Array.isArray(data.videos) ? data.videos : [];

    const results: NormalizedVideoResult[] = [];
    for (const item of items) {
      if (!item || typeof item.video_id !== 'string' || !item.video_id) continue;
      results.push(this.normalizeItem(item, item.video_id));
      if (results.length >= limit) break;
    }

    return results;
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const id = this.extractId(urlOrId);
    if (!id) return undefined;

    const url = `${this.apiBaseUrl}/video_by_id?id=${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return undefined;
    }

    const data = (await res.json()) as PornhubGetVideoResponse;
    if (!data.video) {
      return undefined;
    }

    const videoId = data.video.video_id ?? id;
    return this.normalizeItem(data.video, String(videoId));
  }

  private normalizeItem(item: PornhubItem, id: string): NormalizedVideoResult {
    const title = typeof item.title === 'string' ? item.title : '';
    const durationSeconds = parsePornhubDuration(item.duration);

    let uploader: string | undefined;
    if (typeof item.author === 'string' && item.author) {
      uploader = item.author;
    } else if (Array.isArray(item.pornstars) && item.pornstars.length > 0) {
      uploader = item.pornstars.map(p => p.pornstar_name).filter(Boolean).join(', ');
    }

    const rawThumb = item.default_thumb ?? item.thumb;
    const thumbnailUrl = typeof rawThumb === 'string' && isSafeUrl(rawThumb) ? rawThumb : undefined;
    const webpageUrl = `https://www.pornhub.com/view_video.php?viewkey=${id}`;

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
