import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeUrl,
  canonicalizeUrl,
  createDefaultRegistry,
  DAILYMOTION_DOMAINS,
  deduplicateVideoResults,
  DailymotionProvider,
  EPORNER_DOMAINS,
  EpornerProvider,
  GenericWebProvider,
  isBlockedHost,
  isBlockedIPv4,
  isBlockedIPv6,
  isDomainAllowed,
  isSafeUrl,
  NormalizedVideoResult,
  parsePornhubDuration,
  parseRedTubeDuration,
  parseWebDuration,
  parseXnxxDuration,
  PORNHUB_DOMAINS,
  PornhubProvider,
  REDTUBE_DOMAINS,
  RedTubeProvider,
  VideoProviderRegistry,
  XNXX_DOMAINS,
  XnxxProvider,
} from '../src/modules/video/providers/index.js';

describe('Video Security and SSRF Protection', () => {
  it('blocks private and loopback IPv4 addresses', () => {
    expect(isBlockedIPv4('127.0.0.1')).toBe(true);
    expect(isBlockedIPv4('127.1.2.3')).toBe(true);
    expect(isBlockedIPv4('10.0.0.1')).toBe(true);
    expect(isBlockedIPv4('10.254.1.1')).toBe(true);
    expect(isBlockedIPv4('172.16.0.1')).toBe(true);
    expect(isBlockedIPv4('172.31.255.255')).toBe(true);
    expect(isBlockedIPv4('172.15.0.1')).toBe(false);
    expect(isBlockedIPv4('172.32.0.1')).toBe(false);
    expect(isBlockedIPv4('192.168.0.1')).toBe(true);
    expect(isBlockedIPv4('192.168.100.50')).toBe(true);
    expect(isBlockedIPv4('169.254.169.254')).toBe(true); // AWS metadata
    expect(isBlockedIPv4('0.0.0.0')).toBe(true);
    expect(isBlockedIPv4('100.64.0.1')).toBe(true); // Carrier-grade NAT
    expect(isBlockedIPv4('224.0.0.1')).toBe(true); // Multicast
    expect(isBlockedIPv4('255.255.255.255')).toBe(true);
    expect(isBlockedIPv4('8.8.8.8')).toBe(false);
    expect(isBlockedIPv4('1.1.1.1')).toBe(false);
  });

  it('blocks private, loopback, and RFC 4193 IPv6 addresses', () => {
    expect(isBlockedIPv6('::1')).toBe(true);
    expect(isBlockedIPv6('[::1]')).toBe(true);
    expect(isBlockedIPv6('::')).toBe(true);
    expect(isBlockedIPv6('fe80::1')).toBe(true); // Link-local
    expect(isBlockedIPv6('[fe80::200:5aee:feaa:20a2]')).toBe(true);
    expect(isBlockedIPv6('fc00::1')).toBe(true); // Unique local RFC 4193
    expect(isBlockedIPv6('fd12:3456:789a::1')).toBe(true);
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped loopback
    expect(isBlockedIPv6('::ffff:192.168.1.1')).toBe(true); // IPv4-mapped private
    expect(isBlockedIPv6('2001:4860:4860::8888')).toBe(false); // Google DNS IPv6
  });

  it('blocks localhost aliases and non-routable domains', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('foo.localhost')).toBe(true);
    expect(isBlockedHost('ip6-localhost')).toBe(true);
    expect(isBlockedHost('ip6-loopback')).toBe(true);
    expect(isBlockedHost('service.local')).toBe(true);
    expect(isBlockedHost('db.internal')).toBe(true);
    expect(isBlockedHost('server.lan')).toBe(true);
    expect(isBlockedHost('router.home.arpa')).toBe(true);
    expect(isBlockedHost('dailymotion.com')).toBe(false);
  });

  it('validates allowed domains correctly and prevents subdomain bypasses', () => {
    expect(isDomainAllowed('dailymotion.com', DAILYMOTION_DOMAINS)).toBe(true);
    expect(isDomainAllowed('www.dailymotion.com', DAILYMOTION_DOMAINS)).toBe(true);
    expect(isDomainAllowed('api.dailymotion.com', DAILYMOTION_DOMAINS)).toBe(true);
    expect(isDomainAllowed('dai.ly', DAILYMOTION_DOMAINS)).toBe(true);
    expect(isDomainAllowed('evil-dailymotion.com', DAILYMOTION_DOMAINS)).toBe(false);
    expect(isDomainAllowed('dailymotion.com.evil.com', DAILYMOTION_DOMAINS)).toBe(false);

    expect(isDomainAllowed('eporner.com', EPORNER_DOMAINS)).toBe(true);
    expect(isDomainAllowed('www.eporner.com', EPORNER_DOMAINS)).toBe(true);
    expect(isDomainAllowed('fakeeporner.com', EPORNER_DOMAINS)).toBe(false);

    expect(isDomainAllowed('redtube.com', REDTUBE_DOMAINS)).toBe(true);
    expect(isDomainAllowed('www.redtube.com', REDTUBE_DOMAINS)).toBe(true);
    expect(isDomainAllowed('evilredtube.com', REDTUBE_DOMAINS)).toBe(false);

    expect(isDomainAllowed('pornhub.com', PORNHUB_DOMAINS)).toBe(true);
    expect(isDomainAllowed('www.pornhub.com', PORNHUB_DOMAINS)).toBe(true);
    expect(isDomainAllowed('ei.phncdn.com', PORNHUB_DOMAINS)).toBe(true);
    expect(isDomainAllowed('pornhub.evil.com', PORNHUB_DOMAINS)).toBe(false);

    expect(isDomainAllowed('xnxx.com', XNXX_DOMAINS)).toBe(true);
    expect(isDomainAllowed('thumb-cdn77.xnxx-cdn.com', XNXX_DOMAINS)).toBe(true);
    expect(isDomainAllowed('evil-xnxx.com', XNXX_DOMAINS)).toBe(false);
  });

  it('validates URLs strictly and enforces SSRF safety', () => {
    expect(isSafeUrl('https://www.dailymotion.com/video/x123', DAILYMOTION_DOMAINS)).toBe(true);
    expect(isSafeUrl('http://127.0.0.1:3000')).toBe(false);
    expect(isSafeUrl('http://localhost:8080')).toBe(false);
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeUrl('ftp://example.com/video.mp4')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('https://user:password@www.dailymotion.com/video/x123')).toBe(false);
    expect(isSafeUrl('https://www.dailymotion.com/video/x123\r\nInjected: header')).toBe(false);

    expect(() => assertSafeUrl('https://www.dailymotion.com/video/x123', DAILYMOTION_DOMAINS)).not.toThrow();
    expect(() => assertSafeUrl('http://127.0.0.1')).toThrow(/Unsafe or unauthorized URL/);
  });
});

describe('DailymotionProvider', () => {
  it('has valid metadata and capabilities', () => {
    const provider = new DailymotionProvider();
    expect(provider.id).toBe('dailymotion');
    expect(provider.isAdult).toBe(false);
    expect(provider.capabilities).toEqual({
      searchSupported: true,
      downloadSupported: true,
      metadataSupported: true,
    });
  });

  it('identifies allowed URLs and extracts IDs', () => {
    const provider = new DailymotionProvider();
    expect(provider.isUrlAllowed('https://www.dailymotion.com/video/x7tgad0')).toBe(true);
    expect(provider.isUrlAllowed('https://dai.ly/x7tgad0')).toBe(true);
    expect(provider.isUrlAllowed('https://www.dailymotion.com/about')).toBe(false);
    expect(provider.isUrlAllowed('https://attacker.com/video/x7tgad0')).toBe(false);

    expect(provider.extractId('x7tgad0')).toBe('x7tgad0');
    expect(provider.extractId('https://www.dailymotion.com/video/x7tgad0?playlist=abc')).toBe('x7tgad0');
    expect(provider.extractId('https://dai.ly/x7tgad0')).toBe('x7tgad0');
    expect(provider.extractId('invalid-url-with-no-id/')).toBeUndefined();
  });

  it('searches videos via API and normalizes results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [
          {
            id: 'x8abc1',
            title: 'Nature Documentary',
            duration: 180,
            'owner.screenname': 'NatureDoc',
            thumbnail_url: 'https://www.dailymotion.com/thumbnail/x8abc1.jpg',
            url: 'https://www.dailymotion.com/video/x8abc1',
          },
        ],
      }),
    });

    const provider = new DailymotionProvider({ fetch: mockFetch as unknown as typeof fetch });
    const results = await provider.search('nature', { limit: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('https://api.dailymotion.com/videos?fields=');
    expect(calledUrl).toContain('search=nature');
    expect(calledUrl).toContain('limit=1');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      provider: 'dailymotion',
      id: 'x8abc1',
      title: 'Nature Documentary',
      webpageUrl: 'https://www.dailymotion.com/video/x8abc1',
      downloadable: true,
      durationSeconds: 180,
      uploader: 'NatureDoc',
      thumbnailUrl: 'https://www.dailymotion.com/thumbnail/x8abc1.jpg',
      metadata: expect.any(Object),
    });
  });

  it('resolves a video by ID or URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'x8abc1',
        title: 'Nature Documentary',
        duration: 180,
        owner: { screenname: 'NatureDoc' },
        thumbnail_url: 'https://www.dailymotion.com/thumbnail/x8abc1.jpg',
      }),
    });

    const provider = new DailymotionProvider({ fetch: mockFetch as unknown as typeof fetch });
    const resolved = await provider.resolve('https://dai.ly/x8abc1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.dailymotion.com/video/x8abc1?fields=id,title,duration,owner.screenname,thumbnail_url,url',
      expect.anything()
    );
    expect(resolved?.id).toBe('x8abc1');
    expect(resolved?.uploader).toBe('NatureDoc');
  });

  it('returns undefined if resolve returns 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const provider = new DailymotionProvider({ fetch: mockFetch as unknown as typeof fetch });
    const result = await provider.resolve('xNotFound');
    expect(result).toBeUndefined();
  });
});

describe('EpornerProvider', () => {
  it('has valid metadata and capabilities', () => {
    const provider = new EpornerProvider();
    expect(provider.id).toBe('eporner');
    expect(provider.isAdult).toBe(true);
    expect(provider.capabilities.downloadSupported).toBe(true);
  });

  it('searches and normalizes results including default_thumb objects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        videos: [
          {
            id: 'abc1234',
            title: 'Sample Adult Video',
            length_sec: 645,
            author: 'StudioAlpha',
            default_thumb: { src: 'https://static-s1.eporner.com/thumbs/abc1234.jpg' },
            url: 'https://www.eporner.com/video-abc1234/sample-slug/',
          },
        ],
      }),
    });

    const provider = new EpornerProvider({ fetch: mockFetch as unknown as typeof fetch });
    const results = await provider.search('test', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('abc1234');
    expect(results[0]?.durationSeconds).toBe(645);
    expect(results[0]?.uploader).toBe('StudioAlpha');
    expect(results[0]?.thumbnailUrl).toBe('https://static-s1.eporner.com/thumbs/abc1234.jpg');
    expect(results[0]?.webpageUrl).toBe('https://www.eporner.com/video-abc1234/sample-slug/');
  });

  it('resolves an eporner video by ID', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'abc1234',
        title: 'Resolved Title',
        duration: 300,
        author: 'AuthorX',
        default_thumb: 'https://static-s1.eporner.com/thumb.jpg',
      }),
    });

    const provider = new EpornerProvider({ fetch: mockFetch as unknown as typeof fetch });
    const resolved = await provider.resolve('https://www.eporner.com/video-abc1234/slug/');

    expect(resolved?.id).toBe('abc1234');
    expect(resolved?.title).toBe('Resolved Title');
    expect(resolved?.durationSeconds).toBe(300);
  });
});

describe('RedTubeProvider', () => {
  it('parses duration accurately', () => {
    expect(parseRedTubeDuration('10:30')).toBe(630);
    expect(parseRedTubeDuration('01:10:30')).toBe(4230);
    expect(parseRedTubeDuration('500')).toBe(500);
    expect(parseRedTubeDuration(120)).toBe(120);
    expect(parseRedTubeDuration('')).toBeUndefined();
  });

  it('searches and normalizes videos', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        videos: [
          {
            video: {
              video_id: '987654',
              title: 'Redtube Clip',
              duration: '15:20',
              default_thumb: 'https://img.redtube.com/thumb.jpg',
              author: 'Uploader1',
            },
          },
        ],
      }),
    });

    const provider = new RedTubeProvider({ fetch: mockFetch as unknown as typeof fetch });
    const results = await provider.search('test', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('987654');
    expect(results[0]?.durationSeconds).toBe(920);
    expect(results[0]?.webpageUrl).toBe('https://www.redtube.com/987654');
  });

  it('resolves video by ID or URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        video: {
          video_id: '987654',
          title: 'Resolved Clip',
          duration: '05:00',
        },
      }),
    });

    const provider = new RedTubeProvider({ fetch: mockFetch as unknown as typeof fetch });
    const resolved = await provider.resolve('https://www.redtube.com/987654');

    expect(resolved?.id).toBe('987654');
    expect(resolved?.durationSeconds).toBe(300);
  });
});

describe('PornhubProvider', () => {
  it('has valid metadata and capabilities', () => {
    const provider = new PornhubProvider();
    expect(provider.id).toBe('pornhub');
    expect(provider.isAdult).toBe(true);
    expect(provider.capabilities.downloadSupported).toBe(true);
  });

  it('parses pornhub durations and viewkeys', () => {
    expect(parsePornhubDuration('26:57')).toBe(1617);
    expect(parsePornhubDuration('01:00:00')).toBe(3600);

    const provider = new PornhubProvider();
    expect(provider.extractId('https://www.pornhub.com/view_video.php?viewkey=685ff0eff1523')).toBe(
      '685ff0eff1523'
    );
    expect(provider.extractId('685ff0eff1523')).toBe('685ff0eff1523');
    expect(provider.isUrlAllowed('https://www.pornhub.com/view_video.php?viewkey=685ff0eff1523')).toBe(
      true
    );
    expect(provider.isUrlAllowed('https://evil.com/view_video.php?viewkey=685ff0eff1523')).toBe(false);
  });

  it('searches via official webmasters API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        videos: [
          {
            video_id: '685ff0eff1523',
            title: 'Sample PH Video',
            duration: '26:57',
            default_thumb: 'https://pix-cdn77.phncdn.com/thumb.jpg',
            author: 'CreatorOne',
          },
        ],
      }),
    });

    const provider = new PornhubProvider({ fetch: mockFetch as unknown as typeof fetch });
    const results = await provider.search('test', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('685ff0eff1523');
    expect(results[0]?.title).toBe('Sample PH Video');
    expect(results[0]?.durationSeconds).toBe(1617);
    expect(results[0]?.uploader).toBe('CreatorOne');
    expect(results[0]?.webpageUrl).toBe('https://www.pornhub.com/view_video.php?viewkey=685ff0eff1523');
  });

  it('resolves video via video_by_id endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        video: {
          video_id: '685ff0eff1523',
          title: 'Detailed Title',
          duration: 600,
          pornstars: [{ pornstar_name: 'Star A' }, { pornstar_name: 'Star B' }],
        },
      }),
    });

    const provider = new PornhubProvider({ fetch: mockFetch as unknown as typeof fetch });
    const resolved = await provider.resolve('685ff0eff1523');

    expect(resolved?.id).toBe('685ff0eff1523');
    expect(resolved?.uploader).toBe('Star A, Star B');
    expect(resolved?.durationSeconds).toBe(600);
  });
});

describe('XnxxProvider', () => {
  it('parses duration strings in various formats', () => {
    expect(parseXnxxDuration('38sec')).toBe(38);
    expect(parseXnxxDuration('12min')).toBe(720);
    expect(parseXnxxDuration('1h 10min')).toBe(4200);
    expect(parseXnxxDuration('01:23')).toBe(83);
  });

  it('searches XNXX HTML and extracts cards', async () => {
    const htmlFixture = `
      <div id="video_lh33pb6" data-id="36069109" data-eid="lh33pb6" class="thumb-block ">
        <div class="thumb-inside">
          <div class="thumb">
            <a href="/video-lh33pb6/teste_sd_sd_ds">
              <img src="https://assets-cdn77.xnxx-cdn.com/img/lightbox/lightbox-blank.gif"
                   data-src="https://thumb-cdn77.xnxx-cdn.com/f135478f/0/xn_21_t.jpg" />
            </a>
          </div>
        </div>
        <div class="thumb-under">
          <p><a href="/video-lh33pb6/teste_sd_sd_ds" title="teste sd sd ds">teste sd sd ds</a></p>
          <p class="metadata"><span class="right">40.7k</span> 38sec <span class="video-hd">360p</span></p>
        </div>
      </div>
    `;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlFixture,
    });

    const provider = new XnxxProvider({ fetch: mockFetch as unknown as typeof fetch });
    const results = await provider.search('teste', { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('lh33pb6');
    expect(results[0]?.title).toBe('teste sd sd ds');
    expect(results[0]?.durationSeconds).toBe(38);
    expect(results[0]?.webpageUrl).toBe('https://www.xnxx.com/video-lh33pb6/teste_sd_sd_ds');
    expect(results[0]?.thumbnailUrl).toBe('https://thumb-cdn77.xnxx-cdn.com/f135478f/0/xn_21_t.jpg');
  });

  it('resolves video from page title and og:image', async () => {
    const pageHtml = `
      <html>
        <head>
          <title>Amazing Clip - XNXX.COM</title>
          <meta property="og:image" content="https://thumb-cdn77.xnxx-cdn.com/preview.jpg" />
        </head>
        <body>
          <div class="metadata">12min</div>
        </body>
      </html>
    `;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => pageHtml,
    });

    const provider = new XnxxProvider({ fetch: mockFetch as unknown as typeof fetch });
    const resolved = await provider.resolve('https://www.xnxx.com/video-lh33pb6/test');

    expect(resolved?.id).toBe('lh33pb6');
    expect(resolved?.title).toBe('Amazing Clip');
    expect(resolved?.thumbnailUrl).toBe('https://thumb-cdn77.xnxx-cdn.com/preview.jpg');
    expect(resolved?.durationSeconds).toBe(720);
  });
});

describe('GenericWebProvider', () => {
  it('parses duration formats', () => {
    expect(parseWebDuration('PT1H2M3S')).toBe(3723);
    expect(parseWebDuration('05:30')).toBe(330);
    expect(parseWebDuration(120)).toBe(120);
  });

  it('searches SearxNG video category and filters unsafe URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Public Web Video',
            url: 'https://vimeo.com/12345678',
            thumbnail: 'https://i.vimeocdn.com/video/123.jpg',
            length: '03:15',
            engine: 'vimeo',
          },
          {
            title: 'Internal SSRF Attempt',
            url: 'http://169.254.169.254/latest/video.mp4',
            engine: 'google',
          },
        ],
      }),
    });

    const provider = new GenericWebProvider({
      fetch: mockFetch as unknown as typeof fetch,
      searxngUrl: 'http://searxng:8080',
    });

    const results = await provider.search('ocean', { limit: 5 });

    // The internal SSRF result must be rejected
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('https://vimeo.com/12345678');
    expect(results[0]?.title).toBe('Public Web Video');
    expect(results[0]?.durationSeconds).toBe(195);
    expect(results[0]?.downloadable).toBe(false);
  });
});

describe('VideoProviderRegistry', () => {
  it('canonicalizes URLs and deduplicates properly', () => {
    expect(canonicalizeUrl('https://www.dailymotion.com/video/x123/?utm_source=twitter&ref=feed')).toBe(
      'https://www.dailymotion.com/video/x123'
    );

    const items: NormalizedVideoResult[] = [
      {
        provider: 'dailymotion',
        id: 'x123',
        title: 'Video 1',
        webpageUrl: 'https://www.dailymotion.com/video/x123?utm_source=test',
        downloadable: true,
      },
      {
        provider: 'generic_web',
        id: 'x123-dup',
        title: 'Video 1 Duplicate URL',
        webpageUrl: 'https://www.dailymotion.com/video/x123/',
        downloadable: false,
      },
      {
        provider: 'dailymotion',
        id: 'x123',
        title: 'Same ID duplicate',
        webpageUrl: 'https://dai.ly/x123',
        downloadable: true,
      },
      {
        provider: 'dailymotion',
        id: 'x456',
        title: 'Video 2',
        webpageUrl: 'https://www.dailymotion.com/video/x456',
        downloadable: true,
      },
    ];

    const deduped = deduplicateVideoResults(items);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.id).toBe('x123');
    expect(deduped[1]?.id).toBe('x456');
  });

  it('auto mode queries dailymotion + generic_web and NEVER queries adult providers', async () => {
    const dmSearch = vi.fn().mockResolvedValue([
      {
        provider: 'dailymotion',
        id: 'dm1',
        title: 'DM Result 1',
        webpageUrl: 'https://www.dailymotion.com/video/dm1',
        downloadable: true,
      },
      {
        provider: 'dailymotion',
        id: 'dm2',
        title: 'DM Result 2',
        webpageUrl: 'https://www.dailymotion.com/video/dm2',
        downloadable: true,
      },
    ]);

    const webSearch = vi.fn().mockResolvedValue([
      {
        provider: 'generic_web',
        id: 'web1',
        title: 'Web Result 1',
        webpageUrl: 'https://example.com/web1',
        downloadable: false,
      },
    ]);

    const adultSearch = vi.fn().mockResolvedValue([
      {
        provider: 'pornhub',
        id: 'ph1',
        title: 'Adult Result',
        webpageUrl: 'https://www.pornhub.com/view_video.php?viewkey=ph1',
        downloadable: true,
      },
    ]);

    const dmProvider = new DailymotionProvider();
    vi.spyOn(dmProvider, 'search').mockImplementation(dmSearch);

    const webProvider = new GenericWebProvider();
    vi.spyOn(webProvider, 'search').mockImplementation(webSearch);

    const phProvider = new PornhubProvider();
    vi.spyOn(phProvider, 'search').mockImplementation(adultSearch);

    const registry = new VideoProviderRegistry([dmProvider, webProvider, phProvider]);
    const results = await registry.search('nature documentary', { source: 'auto', limit: 5 });

    expect(dmSearch).toHaveBeenCalledTimes(1);
    expect(webSearch).toHaveBeenCalledTimes(1);
    // Adult provider MUST NEVER BE CALLED in 'auto' mode
    expect(adultSearch).not.toHaveBeenCalled();

    expect(results).toHaveLength(3);
    expect(results.some(r => r.provider === 'dailymotion')).toBe(true);
    expect(results.some(r => r.provider === 'generic_web')).toBe(true);
    expect(results.some(r => r.provider === 'pornhub')).toBe(false);
  });

  it('adult mode queries adult providers and prioritizes Pornhub and XNXX', async () => {
    const phSearch = vi.fn().mockResolvedValue([
      {
        provider: 'pornhub',
        id: 'ph1',
        title: 'PH Video 1',
        webpageUrl: 'https://www.pornhub.com/view_video.php?viewkey=ph1',
        downloadable: true,
      },
    ]);

    const xnxxSearch = vi.fn().mockResolvedValue([
      {
        provider: 'xnxx',
        id: 'xn1',
        title: 'XNXX Video 1',
        webpageUrl: 'https://www.xnxx.com/video-xn1/',
        downloadable: true,
      },
    ]);

    const dmSearch = vi.fn().mockResolvedValue([
      {
        provider: 'dailymotion',
        id: 'dm1',
        title: 'Non-adult Video',
        webpageUrl: 'https://www.dailymotion.com/video/dm1',
        downloadable: true,
      },
    ]);

    const ph = new PornhubProvider();
    vi.spyOn(ph, 'search').mockImplementation(phSearch);

    const xn = new XnxxProvider();
    vi.spyOn(xn, 'search').mockImplementation(xnxxSearch);

    const dm = new DailymotionProvider();
    vi.spyOn(dm, 'search').mockImplementation(dmSearch);

    const registry = new VideoProviderRegistry([ph, xn, dm]);
    const results = await registry.search('query', { source: 'adult', limit: 5 });

    expect(phSearch).toHaveBeenCalledTimes(1);
    expect(xnxxSearch).toHaveBeenCalledTimes(1);
    expect(dmSearch).not.toHaveBeenCalled();

    expect(results).toHaveLength(2);
    expect(results[0]?.provider).toBe('pornhub');
    expect(results[1]?.provider).toBe('xnxx');
  });

  it('supports direct source selection (dailymotion, web, pornhub, xnxx)', async () => {
    const dmSearch = vi.fn().mockResolvedValue([
      {
        provider: 'dailymotion',
        id: 'dm1',
        title: 'DM',
        webpageUrl: 'https://www.dailymotion.com/video/dm1',
        downloadable: true,
      },
    ]);
    const dm = new DailymotionProvider();
    vi.spyOn(dm, 'search').mockImplementation(dmSearch);

    const registry = new VideoProviderRegistry([dm]);
    const results = await registry.search('test', { source: 'dailymotion' });

    expect(dmSearch).toHaveBeenCalled();
    expect(results[0]?.provider).toBe('dailymotion');
  });

  it('enforces limit bounds (default 5, maximum 10, minimum 1)', async () => {
    const mockList = Array.from({ length: 20 }, (_, i) => ({
      provider: 'dailymotion',
      id: `id${i}`,
      title: `Title ${i}`,
      webpageUrl: `https://www.dailymotion.com/video/id${i}`,
      downloadable: true,
    }));

    const dm = new DailymotionProvider();
    vi.spyOn(dm, 'search').mockResolvedValue(mockList);

    const registry = new VideoProviderRegistry([dm]);

    const defaultLimit = await registry.search('test', { source: 'dailymotion' });
    expect(defaultLimit).toHaveLength(5);

    const maxLimit = await registry.search('test', { source: 'dailymotion', limit: 50 });
    expect(maxLimit).toHaveLength(10);

    const minLimit = await registry.search('test', { source: 'dailymotion', limit: 0 });
    expect(minLimit).toHaveLength(1);
  });

  it('routes resolve to provider recognizing URL', async () => {
    const dmResolve = vi.fn().mockResolvedValue({
      provider: 'dailymotion',
      id: 'x7tgad0',
      title: 'Resolved DM',
      webpageUrl: 'https://www.dailymotion.com/video/x7tgad0',
      downloadable: true,
    });

    const dm = new DailymotionProvider();
    vi.spyOn(dm, 'resolve').mockImplementation(dmResolve);

    const registry = new VideoProviderRegistry([dm]);
    const resolved = await registry.resolve('https://www.dailymotion.com/video/x7tgad0');

    expect(dmResolve).toHaveBeenCalledWith('https://www.dailymotion.com/video/x7tgad0', undefined);
    expect(resolved?.id).toBe('x7tgad0');
  });

  it('createDefaultRegistry instantiates all 6 providers', () => {
    const registry = createDefaultRegistry();
    const providers = registry.getProviders();

    expect(providers).toHaveLength(6);
    const ids = providers.map(p => p.id);
    expect(ids).toContain('dailymotion');
    expect(ids).toContain('generic_web');
    expect(ids).toContain('pornhub');
    expect(ids).toContain('xnxx');
    expect(ids).toContain('eporner');
    expect(ids).toContain('redtube');

    const adultIds = registry.getAdultProviders().map(p => p.id);
    expect(adultIds).toEqual(['pornhub', 'xnxx', 'eporner', 'redtube']);

    const safeIds = registry.getSafeProviders().map(p => p.id);
    expect(safeIds).toEqual(['dailymotion', 'generic_web']);
  });
});
