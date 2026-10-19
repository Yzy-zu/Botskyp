import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { EPORNER_DOMAINS, isSafeUrl } from './security.js';

interface EpornerThumb {
  src?: string;
  [key: string]: unknown;
}

interface EpornerItem {
  id?: string;
  title?: string;
  length_sec?: number;
  duration?: number;
  author?: string;
  default_thumb?: string | EpornerThumb;
  thumbnail_url?: string;
  url?: string;
  [key: string]: unknown;
}

interface EpornerSearchResponse {
  videos?: EpornerItem[];
  [key: string]: unknown;
}

export interface EpornerProviderOptions {
  fetch?: typeof fetch | undefined;
  apiBaseUrl?: string | undefined;
}

export class EpornerProvider implements VideoProvider {
  readonly id = 'eporner' as const;
  readonly isAdult = true;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: true,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options?: EpornerProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.apiBaseUrl = options?.apiBaseUrl ?? 'https://www.eporner.com/api/v2';
  }

  isUrlAllowed(url: string): boolean {
    if (!isSafeUrl(url, EPORNER_DOMAINS)) return false;
    try {
      const parsed = new URL(url);
      return /(?:video-|video\/)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  extractId(urlOrId: string): string | undefined {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    if (/^[a-zA-Z0-9]+$/.test(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const match = /(?:video-|video\/)([a-zA-Z0-9]+)/i.exec(parsed.pathname);
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
    const url = `${this.apiBaseUrl}/video/search/?query=${encodeURIComponent(cleanQuery)}&per_page=${limit}`;

    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as EpornerSearchResponse;
    const items = Array.isArray(data.videos) ? data.videos : [];

    return items
      .filter((item): item is EpornerItem & { id: string } => typeof item.id === 'string' && item.id.length > 0)
      .map(item => this.normalizeItem(item));
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const id = this.extractId(urlOrId);
    if (!id) return undefined;

    const fetchInit: RequestInit = options?.signal ? { signal: options.signal } : {};

    // Try primary id endpoint
    const idUrl = `${this.apiBaseUrl}/video/id/?id=${encodeURIComponent(id)}`;
    try {
      const res = await this.fetchImpl(idUrl, fetchInit);
      if (res.ok) {
        const item = (await res.json()) as EpornerItem;
        if (item && typeof item.id === 'string' && item.id.length > 0) {
          return this.normalizeItem(item);
        }
      }
    } catch (err) {
      if (options?.signal?.aborted) throw err;
    }

    // Fallback: search by id
    const searchUrl = `${this.apiBaseUrl}/video/search/?id=${encodeURIComponent(id)}&per_page=1`;
    const searchRes = await this.fetchImpl(searchUrl, fetchInit);
    if (!searchRes.ok) {
      return undefined;
    }

    const searchData = (await searchRes.json()) as EpornerSearchResponse;
    const match = searchData.videos?.find(v => typeof v.id === 'string' && v.id.toLowerCase() === id.toLowerCase());
    if (match && typeof match.id === 'string') {
      return this.normalizeItem(match);
    }

    return undefined;
  }

  private normalizeItem(item: EpornerItem): NormalizedVideoResult {
    const id = String(item.id);
    const title = typeof item.title === 'string' ? item.title : '';

    let durationSeconds: number | undefined;
    if (typeof item.length_sec === 'number' && item.length_sec >= 0) {
      durationSeconds = Math.round(item.length_sec);
    } else if (typeof item.duration === 'number' && item.duration >= 0) {
      durationSeconds = Math.round(item.duration);
    }

    const uploader = typeof item.author === 'string' ? item.author : undefined;

    let thumbnailUrl: string | undefined;
    if (typeof item.default_thumb === 'string' && item.default_thumb) {
      thumbnailUrl = item.default_thumb;
    } else if (
      item.default_thumb &&
      typeof item.default_thumb === 'object' &&
      typeof item.default_thumb.src === 'string'
    ) {
      thumbnailUrl = item.default_thumb.src;
    } else if (typeof item.thumbnail_url === 'string') {
      thumbnailUrl = item.thumbnail_url;
    }

    const webpageUrl =
      typeof item.url === 'string' && item.url ? item.url : `https://www.eporner.com/video-${id}/`;

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
