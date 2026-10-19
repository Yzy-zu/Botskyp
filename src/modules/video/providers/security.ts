import { isIPv4, isIPv6 } from 'node:net';

export const DAILYMOTION_DOMAINS = Object.freeze(['dailymotion.com', 'dai.ly']);
export const EPORNER_DOMAINS = Object.freeze(['eporner.com']);
export const REDTUBE_DOMAINS = Object.freeze(['redtube.com']);
export const PORNHUB_DOMAINS = Object.freeze(['pornhub.com', 'phncdn.com']);
export const XNXX_DOMAINS = Object.freeze(['xnxx.com', 'xnxx-cdn.com']);

/**
 * Parses an IPv6 string into 8 16-bit numeric segments (0..65535).
 * Handles double colon (::) expansion and trailing dotted-quad IPv4 notation.
 */
function parseIPv6Segments(ipStr: string): number[] | null {
  const clean = ipStr.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const leftStrings = halves[0] ? halves[0].split(':') : [];
  const rightStrings = halves[1] ? halves[1].split(':') : [];

  const parseDotted = (arr: string[]): boolean => {
    if (arr.length > 0 && arr[arr.length - 1]!.includes('.')) {
      const v4Parts = arr.pop()!.split('.').map(Number);
      if (v4Parts.length !== 4 || v4Parts.some(p => isNaN(p) || p < 0 || p > 255)) {
        return false;
      }
      arr.push(((v4Parts[0]! << 8) | v4Parts[1]!).toString(16));
      arr.push(((v4Parts[2]! << 8) | v4Parts[3]!).toString(16));
    }
    return true;
  };

  if (!parseDotted(leftStrings) || !parseDotted(rightStrings)) return null;

  const left = leftStrings.map(h => parseInt(h, 16));
  const right = rightStrings.map(h => parseInt(h, 16));
  if (left.some(isNaN) || right.some(isNaN)) return null;

  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const zeros = new Array<number>(missing).fill(0);
    return [...left, ...zeros, ...right];
  }

  if (left.length !== 8) return null;
  return left;
}

function isBlockedIPv4Parts(a: number, b: number): boolean {
  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255 private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local, cloud metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0) return true;
  // 198.18.0.0/15 (benchmark)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0) return true;
  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved / class E) & 255.255.255.255
  if (a >= 224) return true;
  return false;
}

/**
 * Checks if an IPv4 address string falls into private, loopback, or reserved ranges.
 */
export function isBlockedIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  return isBlockedIPv4Parts(parts[0]!, parts[1]!);
}

/**
 * Checks if an IPv6 address string falls into loopback (::1), link-local (fe80::/10),
 * unique-local (fc00::/7 / RFC 4193), or IPv4-mapped blocked ranges.
 */
export function isBlockedIPv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (!isIPv6(clean)) return false;
  const segments = parseIPv6Segments(clean);
  if (!segments || segments.length !== 8) return true;

  // Unspecified ::
  if (segments.every(s => s === 0)) return true;

  // Loopback ::1
  if (segments.slice(0, 7).every(s => s === 0) && segments[7] === 1) return true;

  // Link-local: fe80::/10 (fe80 to febf)
  if ((segments[0]! & 0xffc0) === 0xfe80) return true;

  // Unique local / RFC 4193: fc00::/7 (fc00 to fdff)
  if ((segments[0]! & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::0:0/96)
  const isIPv4Mapped = segments.slice(0, 4).every(s => s === 0) && segments[4] === 0 && segments[5] === 0xffff;
  const isIPv4Compat = segments.slice(0, 6).every(s => s === 0) && (segments[6] !== 0 || segments[7] !== 0);

  if (isIPv4Mapped || isIPv4Compat) {
    const a = (segments[6]! >> 8) & 0xff;
    const b = segments[6]! & 0xff;
    return isBlockedIPv4Parts(a, b);
  }

  return false;
}

/**
 * Determines whether a hostname points to a private, loopback, or non-routable host.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // Localhost aliases
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  if (isIPv4(host)) {
    return isBlockedIPv4(host);
  }

  if (isIPv6(host)) {
    return isBlockedIPv6(host);
  }

  return false;
}

/**
 * Checks if a hostname matches any authorized domain or subdomain.
 */
export function isDomainAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().trim();
  return allowedDomains.some(domain => {
    const d = domain.toLowerCase().trim();
    return host === d || host.endsWith('.' + d);
  });
}

/**
 * Validates that a URL is well-formed, uses http/https, does not contain user credentials,
 * does not target private/internal networks (SSRF), and optionally belongs to allowed domains.
 */
export function isSafeUrl(urlStr: string, allowedDomains?: readonly string[]): boolean {
  if (typeof urlStr !== 'string' || !urlStr.trim() || urlStr.length > 2048) {
    return false;
  }

  // Reject raw control characters or backslashes
  for (let i = 0; i < urlStr.length; i++) {
    const code = urlStr.charCodeAt(i);
    if (code <= 31 || code === 127 || urlStr[i] === '\\') {
      return false;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  // Only http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Disallow user credentials
  if (parsed.username || parsed.password) {
    return false;
  }

  // SSRF check on hostname
  if (isBlockedHost(parsed.hostname)) {
    return false;
  }

  // Provider domain allowlist check if specified
  if (allowedDomains && allowedDomains.length > 0) {
    if (!isDomainAllowed(parsed.hostname, allowedDomains)) {
      return false;
    }
  }

  return true;
}

/**
 * Asserts that a URL is safe according to isSafeUrl, returning the parsed URL or throwing an Error.
 */
export function assertSafeUrl(urlStr: string, allowedDomains?: readonly string[]): URL {
  if (!isSafeUrl(urlStr, allowedDomains)) {
    throw new Error(`Unsafe or unauthorized URL: ${urlStr}`);
  }
  return new URL(urlStr);
}
