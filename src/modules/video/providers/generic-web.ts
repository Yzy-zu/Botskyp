import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { isSafeUrl } from './security.js';

interface SearxngResultItem {
  title?: string;
  url?: string;
  content?: string;
  thumbnail?: string;
  thumbnail_src?: string;
  img_src?: string;
  length?: string | number;
  author?: string;
  engine?: string;
  [key: string]: unknown;
}

interface SearxngSearchResponse {
  results?: SearxngResultItem[];
  [key: string]: unknown;
}

export interface GenericWebProviderOptions {
  fetch?: typeof fetch | undefined;
  searxngUrl?: string | undefined;
}

export function parseWebDuration(duration: unknown): number | undefined {
  if (typeof duration === 'number' && duration >= 0) {
    return Math.round(duration);
  }
  if (typeof duration === 'string') {
    const trimmed = duration.trim();
    if (!trimmed) return undefined;

    // Numeric string seconds
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }

    // ISO 8601 duration: PT1H2M3S
    if (/^PT/i.test(trimmed)) {
      const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(trimmed);
      if (match) {
        const h = parseInt(match[1] ?? '0', 10);
        const m = parseInt(match[2] ?? '0', 10);
        const s = parseInt(match[3] ?? '0', 10);
        return h * 3600 + m * 60 + s;
      }
    }

    // MM:SS or HH:MM:SS
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

export class GenericWebProvider implements VideoProvider {
  readonly id = 'generic_web' as const;
  readonly isAdult = false;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: false,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly searxngUrl: string;

  constructor(options?: GenericWebProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.searxngUrl = options?.searxngUrl ?? process.env.SEARXNG_URL ?? 'http://searxng:8080';
  }

  isUrlAllowed(url: string): boolean {
    return isSafeUrl(url);
  }

  async search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]> {
    options?.signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const endpoint = new URL('/search', this.searxngUrl);
    endpoint.searchParams.set('q', cleanQuery);
    endpoint.searchParams.set('categories', 'videos');
    endpoint.searchParams.set('format', 'json');

    const res = await this.fetchImpl(
      endpoint.toString(),
      options?.signal ? { signal: options.signal } : {}
    );
    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as SearxngSearchResponse;
    const items = Array.isArray(data.results) ? data.results : [];

    const results: NormalizedVideoResult[] = [];
    for (const item of items) {
      if (typeof item.url !== 'string' || !item.url) continue;
      // Discard unsafe URLs (SSRF protection)
      if (!isSafeUrl(item.url)) continue;

      results.push(this.normalizeItem(item));
      if (results.length >= limit) break;
    }

    return results;
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const clean = urlOrId.trim();
    if (!clean || !isSafeUrl(clean)) {
      return undefined;
    }

    return {
      provider: this.id,
      id: clean,
      title: clean,
      webpageUrl: clean,
      downloadable: false,
      metadata: { resolvedUrl: clean },
    };
  }

  private normalizeItem(item: SearxngResultItem): NormalizedVideoResult {
    const webpageUrl = item.url!;
    const id = webpageUrl;
    const title = typeof item.title === 'string' && item.title ? item.title : webpageUrl;
    const durationSeconds = parseWebDuration(item.length);
    const uploader =
      typeof item.author === 'string' && item.author
        ? item.author
        : typeof item.engine === 'string'
          ? item.engine
          : undefined;

    const rawThumb = item.thumbnail ?? item.thumbnail_src ?? item.img_src;
    const thumbnailUrl = typeof rawThumb === 'string' && isSafeUrl(rawThumb) ? rawThumb : undefined;

    return {
      provider: this.id,
      id,
      title,
      webpageUrl,
      downloadable: false,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(uploader !== undefined ? { uploader } : {}),
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      metadata: item,
    };
  }
}
