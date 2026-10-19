import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { DAILYMOTION_DOMAINS, isSafeUrl } from './security.js';

interface DailymotionItem {
  id?: string;
  title?: string;
  duration?: number;
  'owner.screenname'?: string;
  owner?: { screenname?: string };
  thumbnail_url?: string;
  url?: string;
  [key: string]: unknown;
}

interface DailymotionSearchResponse {
  list?: DailymotionItem[];
  [key: string]: unknown;
}

export interface DailymotionProviderOptions {
  fetch?: typeof fetch | undefined;
  apiBaseUrl?: string | undefined;
}

export class DailymotionProvider implements VideoProvider {
  readonly id = 'dailymotion' as const;
  readonly isAdult = false;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: true,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options?: DailymotionProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.apiBaseUrl = options?.apiBaseUrl ?? 'https://api.dailymotion.com';
  }

  isUrlAllowed(url: string): boolean {
    if (!isSafeUrl(url, DAILYMOTION_DOMAINS)) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host === 'dai.ly' || host.endsWith('.dai.ly')) {
        return parsed.pathname.length > 1;
      }
      return parsed.pathname.includes('/video/');
    } catch {
      return false;
    }
  }

  extractId(urlOrId: string): string | undefined {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    // Check if it's already an ID (alphanumeric, typically starts with x or k)
    if (/^[a-zA-Z0-9]+$/.test(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      if (host === 'dai.ly' || host.endsWith('.dai.ly')) {
        const seg = parsed.pathname.slice(1).split(/[/?#]/)[0];
        return seg && /^[a-zA-Z0-9]+$/.test(seg) ? seg : undefined;
      }
      if (DAILYMOTION_DOMAINS.some(d => host === d || host.endsWith('.' + d))) {
        const match = /(?:\/video\/|\/embed\/video\/)([a-zA-Z0-9]+)/.exec(parsed.pathname);
        if (match?.[1]) return match[1];
      }
    } catch {
      // Not a valid URL
    }

    return undefined;
  }

  async search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]> {
    options?.signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const url = `${this.apiBaseUrl}/videos?fields=id,title,duration,owner.screenname,thumbnail_url,url&search=${encodeURIComponent(cleanQuery)}&limit=${limit}`;

    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as DailymotionSearchResponse;
    const items = Array.isArray(data.list) ? data.list : [];

    return items
      .filter((item): item is DailymotionItem & { id: string } => typeof item.id === 'string' && item.id.length > 0)
      .map(item => this.normalizeItem(item));
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const id = this.extractId(urlOrId);
    if (!id) return undefined;

    const url = `${this.apiBaseUrl}/video/${encodeURIComponent(id)}?fields=id,title,duration,owner.screenname,thumbnail_url,url`;
    const res = await this.fetchImpl(url, options?.signal ? { signal: options.signal } : {});
    if (!res.ok) {
      return undefined;
    }

    const item = (await res.json()) as DailymotionItem;
    if (!item || typeof item.id !== 'string') {
      return undefined;
    }

    return this.normalizeItem(item);
  }

  private normalizeItem(item: DailymotionItem): NormalizedVideoResult {
    const id = String(item.id);
    const title = typeof item.title === 'string' ? item.title : '';
    const durationSeconds =
      typeof item.duration === 'number' && item.duration >= 0 ? Math.round(item.duration) : undefined;
    const uploader =
      typeof item['owner.screenname'] === 'string'
        ? item['owner.screenname']
        : typeof item.owner?.screenname === 'string'
          ? item.owner.screenname
          : undefined;
    const thumbnailUrl = typeof item.thumbnail_url === 'string' && item.thumbnail_url ? item.thumbnail_url : undefined;
    const webpageUrl = `https://www.dailymotion.com/video/${id}`;

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
