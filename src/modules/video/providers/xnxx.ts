import type {
  NormalizedVideoResult,
  VideoProvider,
  VideoResolveOptions,
  VideoSearchOptions,
} from './types.js';
import { isSafeUrl, XNXX_DOMAINS } from './security.js';

export interface XnxxProviderOptions {
  fetch?: typeof fetch | undefined;
  baseUrl?: string | undefined;
}

export function parseXnxxDuration(dur: unknown): number | undefined {
  if (typeof dur === 'number' && dur >= 0) return Math.round(dur);
  if (typeof dur !== 'string') return undefined;
  const s = dur.trim().toLowerCase();
  if (!s) return undefined;

  let totalSeconds = 0;
  let matched = false;

  const hours = /(\d+)\s*h(?:our)?s?/i.exec(s);
  if (hours?.[1]) {
    totalSeconds += parseInt(hours[1], 10) * 3600;
    matched = true;
  }
  const mins = /(\d+)\s*min(?:ute)?s?/i.exec(s);
  if (mins?.[1]) {
    totalSeconds += parseInt(mins[1], 10) * 60;
    matched = true;
  }
  const secs = /(\d+)\s*sec(?:ond)?s?/i.exec(s);
  if (secs?.[1]) {
    totalSeconds += parseInt(secs[1], 10);
    matched = true;
  }

  if (matched) return totalSeconds;

  const parts = s.split(':').map(Number);
  if (parts.length === 2 && parts.every(n => !isNaN(n) && n >= 0)) {
    return parts[0]! * 60 + parts[1]!;
  }
  if (parts.length === 3 && parts.every(n => !isNaN(n) && n >= 0)) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }

  return undefined;
}

export class XnxxProvider implements VideoProvider {
  readonly id = 'xnxx' as const;
  readonly isAdult = true;
  readonly capabilities = {
    searchSupported: true,
    downloadSupported: true,
    metadataSupported: true,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options?: XnxxProviderOptions) {
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.baseUrl = (options?.baseUrl ?? 'https://www.xnxx.com').replace(/\/+$/, '');
  }

  isUrlAllowed(url: string): boolean {
    if (!isSafeUrl(url, XNXX_DOMAINS)) return false;
    try {
      const parsed = new URL(url);
      return /\/video-[a-zA-Z0-9]+/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  extractId(urlOrId: string): string | undefined {
    const trimmed = urlOrId.trim();
    if (!trimmed) return undefined;

    if (/^[a-zA-Z0-9]+$/.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('.')) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const match = /\/video-([a-zA-Z0-9]+)/i.exec(parsed.pathname);
      if (match?.[1]) return match[1];
    } catch {
      // Not a URL
    }

    const match = /(?:^|\/)video-([a-zA-Z0-9]+)/i.exec(trimmed);
    if (match?.[1]) return match[1];

    return undefined;
  }

  async search(query: string, options?: VideoSearchOptions): Promise<NormalizedVideoResult[]> {
    options?.signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const url = `${this.baseUrl}/search/${encodeURIComponent(cleanQuery)}`;

    const res = await this.fetchImpl(
      url,
      options?.signal ? { signal: options.signal } : {}
    );
    if (!res.ok) {
      return [];
    }

    const html = await res.text();
    return this.parseSearchHtml(html, limit);
  }

  async resolve(urlOrId: string, options?: VideoResolveOptions): Promise<NormalizedVideoResult | undefined> {
    options?.signal?.throwIfAborted();
    const id = this.extractId(urlOrId);
    if (!id) return undefined;

    let targetUrl = `${this.baseUrl}/video-${id}/`;
    if (urlOrId.startsWith('http://') || urlOrId.startsWith('https://')) {
      try {
        const parsed = new URL(urlOrId);
        if (this.isUrlAllowed(urlOrId)) {
          targetUrl = parsed.href;
        }
      } catch {
        // Fall back to targetUrl
      }
    }

    try {
      const res = await this.fetchImpl(
        targetUrl,
        options?.signal ? { signal: options.signal } : {}
      );
      if (res.ok) {
        const html = await res.text();
        const titleMatch = /<title>(.*?)<\/title>/i.exec(html);
        let title = titleMatch?.[1] ? titleMatch[1].replace(/\s*-\s*XNXX\.COM$/i, '').trim() : '';
        if (!title) title = `XNXX Video ${id}`;

        const ogImageMatch = /<meta\s+property="og:image"\s+content="([^"]+)"/i.exec(html);
        const thumb = ogImageMatch?.[1];
        const thumbnailUrl = thumb && isSafeUrl(thumb) ? thumb : undefined;

        const durMatch = /"duration":\s*(\d+)/i.exec(html) || /class="metadata">[\s\S]*?(\d+\s*(?:sec|min|h))/i.exec(html);
        const durationSeconds = durMatch?.[1] ? parseXnxxDuration(durMatch[1]) : undefined;

        return {
          provider: this.id,
          id,
          title,
          webpageUrl: targetUrl,
          downloadable: true,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
          metadata: { resolvedFrom: targetUrl },
        };
      }
    } catch (err) {
      if (options?.signal?.aborted) throw err;
    }

    // Fallback resolution with basic metadata
    return {
      provider: this.id,
      id,
      title: `XNXX Video ${id}`,
      webpageUrl: targetUrl,
      downloadable: true,
      metadata: { fallback: true },
    };
  }

  private parseSearchHtml(html: string, limit: number): NormalizedVideoResult[] {
    const results: NormalizedVideoResult[] = [];
    const seenIds = new Set<string>();

    const blockRegex = /<div[^>]+id="video_([a-zA-Z0-9]+)"[^>]*>([\s\S]*?)(?=<div[^>]+id="video_|$)/gi;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(html)) !== null) {
      const id = match[1];
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const block = match[2] ?? '';
      const linkMatch = /href="(\/video-[^"]+)"/i.exec(block);
      const path = linkMatch?.[1] ?? `/video-${id}/`;
      const webpageUrl = `${this.baseUrl}${path}`;

      const titleMatch =
        /title="([^"]+)"/i.exec(block) ??
        /<a[^>]+href="\/video-[^"]+"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const rawTitle = titleMatch?.[1] ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      const title = rawTitle || `Video ${id}`;

      const imgMatch =
        /data-src="([^"]+)"/i.exec(block) ??
        /data-mzl="([^"]+)"/i.exec(block) ??
        /src="([^"]+)"/i.exec(block);
      const rawThumb = imgMatch?.[1];
      const thumbnailUrl =
        rawThumb && !rawThumb.includes('blank.gif') && isSafeUrl(rawThumb) ? rawThumb : undefined;

      const durMatch = /(\d+\s*(?:sec|min|h(?:our)?s?))/i.exec(block);
      const durationSeconds = durMatch?.[1] ? parseXnxxDuration(durMatch[1]) : undefined;

      results.push({
        provider: this.id,
        id,
        title,
        webpageUrl,
        downloadable: true,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
        metadata: { path },
      });

      if (results.length >= limit) break;
    }

    // Fallback parser if block structure wasn't matched
    if (results.length === 0) {
      const fallbackRegex = /<a[^>]+href="(\/video-([a-zA-Z0-9]+)\/[^"]*)"[^>]*title="([^"]*)"/gi;
      let fbMatch: RegExpExecArray | null;
      while ((fbMatch = fallbackRegex.exec(html)) !== null) {
        const path = fbMatch[1]!;
        const id = fbMatch[2]!;
        const title = fbMatch[3]!.trim() || `Video ${id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        results.push({
          provider: this.id,
          id,
          title,
          webpageUrl: `${this.baseUrl}${path}`,
          downloadable: true,
          metadata: { path },
        });

        if (results.length >= limit) break;
      }
    }

    return results;
  }
}
