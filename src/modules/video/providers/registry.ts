import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoRegistrySearchOptions,
  VideoRegistrySearchSource,
  VideoResolveOptions,
} from './types.js';
import { DailymotionProvider } from './dailymotion.js';
import { GenericWebProvider } from './generic-web.js';
import { PornhubProvider } from './pornhub.js';
import { XnxxProvider } from './xnxx.js';
import { EpornerProvider } from './eporner.js';
import { RedTubeProvider } from './redtube.js';

export function canonicalizeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const dropParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'ref_',
      'fbclid',
      'gclid',
      'from',
      'feature',
      'trk',
    ];
    for (const p of dropParams) {
      u.searchParams.delete(p);
    }
    u.hash = '';
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    u.pathname = pathname;
    return u.toString().toLowerCase();
  } catch {
    return urlStr.trim().toLowerCase();
  }
}

export function deduplicateVideoResults(
  results: readonly NormalizedVideoResult[]
): NormalizedVideoResult[] {
  const seenCanonicalUrls = new Set<string>();
  const seenProviderIds = new Set<string>();
  const deduplicated: NormalizedVideoResult[] = [];

  for (const item of results) {
    const canonical = canonicalizeUrl(item.webpageUrl);
    const providerKey = `${item.provider.toLowerCase()}:${item.id.toLowerCase()}`;

    if (seenCanonicalUrls.has(canonical) || seenProviderIds.has(providerKey)) {
      continue;
    }

    seenCanonicalUrls.add(canonical);
    seenProviderIds.add(providerKey);
    deduplicated.push(item);
  }

  return deduplicated;
}

function interleaveResults(groups: NormalizedVideoResult[][]): NormalizedVideoResult[] {
  const merged: NormalizedVideoResult[] = [];
  const maxLen = Math.max(0, ...groups.map(g => g.length));

  for (let i = 0; i < maxLen; i++) {
    for (const group of groups) {
      const item = group[i];
      if (item) {
        merged.push(item);
      }
    }
  }

  return merged;
}

export interface CreateDefaultRegistryOptions {
  fetch?: typeof fetch | undefined;
  searxngUrl?: string | undefined;
}

export class VideoProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>();

  constructor(initialProviders: readonly VideoProvider[] = []) {
    for (const provider of initialProviders) {
      this.registerProvider(provider);
    }
  }

  registerProvider(provider: VideoProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  getProvider(id: string): VideoProvider | undefined {
    return this.providers.get(id);
  }

  getProviders(): VideoProvider[] {
    return Array.from(this.providers.values());
  }

  getAdultProviders(): VideoProvider[] {
    return Array.from(this.providers.values()).filter(p => p.isAdult);
  }

  getSafeProviders(): VideoProvider[] {
    return Array.from(this.providers.values()).filter(p => !p.isAdult);
  }

  async search(
    query: string,
    options?: VideoRegistrySearchOptions
  ): Promise<NormalizedVideoResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const requestedLimit = options?.limit ?? 5;
    const limit = Math.min(Math.max(1, requestedLimit), 10);
    const source: VideoRegistrySearchSource = options?.source ?? 'auto';

    if (source === 'auto') {
      return this.searchAuto(cleanQuery, limit, options?.signal);
    }

    if (source === 'adult') {
      return this.searchAdult(cleanQuery, limit, options?.signal);
    }

    if (source === 'dailymotion') {
      const provider = this.getProvider('dailymotion');
      if (!provider) return [];
      const results = await provider.search(cleanQuery, { limit, signal: options?.signal });
      return deduplicateVideoResults(results).slice(0, limit);
    }

    if (source === 'web') {
      const provider = this.getProvider('generic_web');
      if (!provider) return [];
      const results = await provider.search(cleanQuery, { limit, signal: options?.signal });
      return deduplicateVideoResults(results).slice(0, limit);
    }

    // Direct provider ID search (e.g. 'pornhub', 'xnxx', 'eporner', 'redtube')
    const provider = this.getProvider(source);
    if (!provider) return [];
    const results = await provider.search(cleanQuery, { limit, signal: options?.signal });
    return deduplicateVideoResults(results).slice(0, limit);
  }

  async resolve(
    urlOrId: string,
    options?: VideoResolveOptions
  ): Promise<NormalizedVideoResult | undefined> {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    // First try providers that explicitly recognize the URL
    const recognizedProviders: VideoProvider[] = [];
    const otherProviders: VideoProvider[] = [];

    for (const provider of this.providers.values()) {
      if (provider.isUrlAllowed(trimmed)) {
        recognizedProviders.push(provider);
      } else {
        otherProviders.push(provider);
      }
    }

    for (const provider of [...recognizedProviders, ...otherProviders]) {
      try {
        const result = await provider.resolve(trimmed, options);
        if (result) return result;
      } catch (err) {
        if (options?.signal?.aborted) throw err;
      }
    }

    return undefined;
  }

  private async searchAuto(
    query: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<NormalizedVideoResult[]> {
    // CRITICAL: NEVER query adult providers in 'auto' mode
    const dailymotion = this.getProvider('dailymotion');
    const genericWeb = this.getProvider('generic_web');

    const tasks: Promise<NormalizedVideoResult[]>[] = [];

    if (dailymotion) {
      tasks.push(dailymotion.search(query, { limit, signal }).catch(() => []));
    }
    if (genericWeb) {
      tasks.push(genericWeb.search(query, { limit, signal }).catch(() => []));
    }

    const settled = await Promise.all(tasks);
    const interleaved = interleaveResults(settled);
    return deduplicateVideoResults(interleaved).slice(0, limit);
  }

  private async searchAdult(
    query: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<NormalizedVideoResult[]> {
    // Adult providers order: Pornhub and XNXX first as main ones, then Eporner, RedTube, and any others
    const adultProviders = this.getAdultProviders().sort((a, b) => {
      const priorityOrder = ['pornhub', 'xnxx', 'eporner', 'redtube'];
      const idxA = priorityOrder.indexOf(a.id);
      const idxB = priorityOrder.indexOf(b.id);
      const rankA = idxA === -1 ? 99 : idxA;
      const rankB = idxB === -1 ? 99 : idxB;
      return rankA - rankB;
    });

    if (adultProviders.length === 0) return [];

    const tasks = adultProviders.map(provider =>
      provider.search(query, { limit, signal }).catch(() => [])
    );

    const settled = await Promise.all(tasks);
    const interleaved = interleaveResults(settled);
    return deduplicateVideoResults(interleaved).slice(0, limit);
  }
}

export function createDefaultRegistry(
  options?: CreateDefaultRegistryOptions
): VideoProviderRegistry {
  const fetchImpl = options?.fetch;
  const searxngUrl = options?.searxngUrl;

  const providerOpts = fetchImpl ? { fetch: fetchImpl } : {};
  const webOpts = {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(searxngUrl ? { searxngUrl } : {}),
  };

  return new VideoProviderRegistry([
    new DailymotionProvider(providerOpts),
    new GenericWebProvider(webOpts),
    new PornhubProvider(providerOpts),
    new XnxxProvider(providerOpts),
    new EpornerProvider(providerOpts),
    new RedTubeProvider(providerOpts),
  ]);
}
