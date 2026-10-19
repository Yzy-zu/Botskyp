import pino from 'pino';
import { product } from '../../../config/product.js';
import { LlmUnavailable } from '../quota.js';
import type { FailureKind } from './types.js';

const log = pino({ level: 'info' });

export class ProviderAttemptError extends LlmUnavailable {
  readonly failureKind: FailureKind;
  constructor(
    kind: FailureKind,
    readonly status?: number | undefined,
    readonly retryAfterMs?: number | undefined,
    readonly providerErrorCode?: string | undefined,
  ) {
    super(kind === 'auth' ? 'disabled' : kind === 'incompatible' ? 'invalid' : kind);
    this.failureKind = kind;
  }
}

export type CredentialState = {
  keyIndex: number;
  id: string;
  available: boolean;
  cooldownUntil: number;
  consecutive429: number;
  consecutiveErrors: number;
  lastUsedAt: number;
  requests: number;
  successes: number;
  rateLimited: number;
  failures: number;
  lastFailureKind?: FailureKind | undefined;
};

export type PoolOptions = {
  providerPrefix?: string | undefined;
  maxConcurrent?: number | undefined;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
  validateKey?: ((key: string) => boolean) | undefined;
};

type Waiter = { grant: () => void; reject: () => void };

/** Retry-After supports delta-seconds and HTTP dates. A provider delay is never shortened. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, Number.MAX_SAFE_INTEGER - now) : undefined;
  }
  if (!/^[A-Za-z]{3},\s/.test(raw)) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function defaultValidateApiKey(key: string): boolean {
  return /^[\x21-\x2B\x2D-\x7E]+$/.test(key);
}

export class CredentialPool {
  #keys: string[];
  #states: CredentialState[];
  #cursor = 0;
  #active = 0;
  #queue: Waiter[] = [];
  #latencies: number[] = [];
  #failovers = 0;
  #exhausted = 0;
  #now: () => number;
  #log: (message: string) => void;
  readonly prefix: string;
  readonly maxConcurrent: number;

  constructor(keys: readonly string[], options: PoolOptions = {}) {
    const validator = options.validateKey ?? defaultValidateApiKey;
    this.prefix = options.providerPrefix ?? 'key';
    this.#keys = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
    if (!this.#keys.length || this.#keys.some(key => !validator(key))) {
      throw new Error(`Invalid configuration: ${this.prefix.toUpperCase()}_API_KEYS / ${this.prefix.toUpperCase()}_API_KEY`);
    }
    this.maxConcurrent = options.maxConcurrent ?? product.llmMaxConcurrentCalls;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > product.llmMaxConfiguredConcurrency) {
      throw new Error('Invalid configuration: LLM_MAX_CONCURRENT_CALLS');
    }
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (message => log.info(message));
    this.#states = this.#keys.map((_, i) => ({
      keyIndex: i + 1,
      id: `${this.prefix}-key-${i + 1}`,
      available: true,
      cooldownUntil: 0,
      consecutive429: 0,
      consecutiveErrors: 0,
      lastUsedAt: 0,
      requests: 0,
      successes: 0,
      rateLimited: 0,
      failures: 0,
    }));
  }

  snapshot() {
    const keys = this.#states.map(state => ({ ...state }));
    const latency = [...this.#latencies].sort((a, b) => a - b);
    const percentile = (p: number) => latency.length ? latency[Math.ceil(latency.length * p) - 1]! : 0;
    return {
      prefix: this.prefix,
      configured: keys.length,
      healthy: keys.filter(k => k.available).length,
      available: keys.filter(k => k.available && k.cooldownUntil <= this.#now()).length,
      cooldown: keys.filter(k => k.available && k.cooldownUntil > this.#now()).length,
      requests: keys.reduce((sum, k) => sum + k.requests, 0),
      rateLimited: keys.reduce((sum, k) => sum + k.rateLimited, 0),
      failovers: this.#failovers,
      exhausted: this.#exhausted,
      active: this.#active,
      queued: this.#queue.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      keys,
    };
  }

  get states(): readonly CredentialState[] {
    return this.#states;
  }

  get keyCount(): number {
    return this.#keys.length;
  }

  getState(credentialId: string): CredentialState | undefined {
    return this.#states.find(s => s.id === credentialId);
  }

  selectCandidate(): { key: string; state: CredentialState } | undefined {
    for (let n = 0; n < this.#states.length; n++) {
      const index = (this.#cursor + n) % this.#states.length;
      const key = this.#states[index]!;
      if (key.available && key.cooldownUntil <= this.#now()) {
        this.#cursor = (index + 1) % this.#states.length;
        key.lastUsedAt = this.#now();
        return { key: this.#keys[index]!, state: key };
      }
    }
    return undefined;
  }

  private select(attempted: Set<number>): CredentialState | undefined {
    for (let n = 0; n < this.#states.length; n++) {
      const index = (this.#cursor + n) % this.#states.length;
      const key = this.#states[index]!;
      if (key.available && key.cooldownUntil <= this.#now() && !attempted.has(index)) {
        this.#cursor = (index + 1) % this.#states.length;
        attempted.add(index);
        key.lastUsedAt = this.#now();
        return key;
      }
    }
    return undefined;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new LlmUnavailable('timeout');
    if (this.#active < this.maxConcurrent) {
      this.#active++;
      return;
    }
    if (this.#queue.length >= product.llmMaxQueuedCalls) {
      throw new LlmUnavailable('local_limit', 'concurrency');
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', waiter.reject);
      };
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        reject: () => {
          cleanup();
          this.#queue = this.#queue.filter(entry => entry !== waiter);
          reject(new LlmUnavailable(signal?.aborted ? 'timeout' : 'local_limit', 'concurrency'));
        },
      };
      const timer = setTimeout(waiter.reject, product.llmQueueWaitMs);
      signal?.addEventListener('abort', waiter.reject, { once: true });
      this.#queue.push(waiter);
    });
  }

  release(): void {
    const waiter = this.#queue.shift();
    if (waiter) waiter.grant();
    else this.#active--;
  }

  recordSuccess(keyIndex: number, latencyMs: number): void {
    const key = this.#states[keyIndex - 1];
    if (!key) return;
    key.requests++;
    key.successes++;
    key.consecutive429 = 0;
    key.consecutiveErrors = 0;
    this.#latencies.push(Math.max(0, latencyMs));
    if (this.#latencies.length > product.llmLatencySamples) this.#latencies.shift();
  }

  recordFailure(keyIndex: number, error: ProviderAttemptError, latencyMs: number): void {
    const key = this.#states[keyIndex - 1];
    if (!key) return;
    key.requests++;
    key.failures++;
    key.consecutiveErrors++;
    this.#latencies.push(Math.max(0, latencyMs));
    if (this.#latencies.length > product.llmLatencySamples) this.#latencies.shift();

    if (error.failureKind === 'auth' || error.status === 401) {
      key.available = false;
      key.lastFailureKind = 'auth';
      this.#log(`${key.id} disabled: unauthorized`);
    } else if (error.status === 429 || error.failureKind === 'quota') {
      key.rateLimited++;
      key.consecutive429++;
      key.lastFailureKind = 'quota';
      const backoff = Math.min(product.llmCooldownMs * 2 ** Math.min(key.consecutive429 - 1, 10), product.llmMaxCooldownMs);
      key.cooldownUntil = Math.max(key.cooldownUntil, this.#now() + (error.retryAfterMs ?? backoff));
      this.#log(`${key.id} cooldown: rate_limited`);
    } else if (error.failureKind === 'provider' && (error.status === undefined || error.status >= 500)) {
      key.lastFailureKind = 'provider';
      const maxProviderCooldownMs = 30_000;
      const backoff = Math.min(product.llmBackoffMs * 2 ** Math.min(key.consecutiveErrors - 1, 10), maxProviderCooldownMs);
      key.cooldownUntil = Math.max(key.cooldownUntil, this.#now() + (error.retryAfterMs ?? backoff));
      this.#log(`${key.id} cooldown: provider_5xx`);
    } else if (error.failureKind === 'timeout') {
      key.lastFailureKind = 'timeout';
      const timeoutMaxCooldownMs = 15_000;
      const backoff = Math.min(product.llmBackoffMs * 2 ** Math.min(key.consecutiveErrors - 1, 10), timeoutMaxCooldownMs);
      key.cooldownUntil = Math.max(key.cooldownUntil, this.#now() + backoff);
      this.#log(`${key.id} cooldown: timeout`);
    }
  }

  disable(credentialId: string): void {
    const key = this.#states.find(s => s.id === credentialId);
    if (key) {
      key.available = false;
      key.lastFailureKind = 'auth';
      this.#log(`${key.id} disabled: unauthorized`);
    }
  }

  reset(): void {
    this.#cursor = 0;
    this.#active = 0;
    this.#queue = [];
    this.#failovers = 0;
    this.#exhausted = 0;
    for (const s of this.#states) {
      s.available = true;
      s.cooldownUntil = 0;
      s.consecutive429 = 0;
      s.consecutiveErrors = 0;
      s.requests = 0;
      s.successes = 0;
      s.rateLimited = 0;
      s.failures = 0;
      s.lastFailureKind = undefined;
    }
  }

  async executeKey<T>(
    keyIndex: number,
    request: (apiKey: string, keyIndex: number, credentialId: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(signal);
    const key = this.#states[keyIndex - 1];
    if (!key || !key.available || key.cooldownUntil > this.#now()) {
      this.release();
      throw new ProviderAttemptError('quota');
    }
    const start = this.#now();
    try {
      const result = await request(this.#keys[keyIndex - 1]!, keyIndex, key.id);
      this.recordSuccess(keyIndex, this.#now() - start);
      return result;
    } catch (error) {
      if (error instanceof ProviderAttemptError) {
        this.recordFailure(keyIndex, error, this.#now() - start);
      }
      throw error;
    } finally {
      this.release();
    }
  }

  async run<T>(request: (apiKey: string, keyIndex: number, credentialId: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      const attempted = new Set<number>();
      let previousFailure: LlmUnavailable | undefined;
      while (attempted.size < this.#states.length) {
        if (signal?.aborted) throw new LlmUnavailable('timeout');
        const key = this.select(attempted);
        if (!key) break;
        const failover = Boolean(previousFailure);
        const start = this.#now();
        try {
          const result = await request(this.#keys[key.keyIndex - 1]!, key.keyIndex, key.id);
          if (failover) this.#failovers++;
          this.recordSuccess(key.keyIndex, this.#now() - start);
          return result;
        } catch (error) {
          if (!(error instanceof ProviderAttemptError)) throw error;
          if (failover) this.#failovers++;
          previousFailure = error;
          this.recordFailure(key.keyIndex, error, this.#now() - start);
          if (error.kind === 'invalid' || error.kind === 'blocked') throw error;
        }
      }
      this.#exhausted++;
      this.#log(`${this.prefix} key pool exhausted`);
      const rawFallback = this.#states.find(k => k.lastFailureKind)?.lastFailureKind ?? (this.#states.some(k => k.available) ? 'quota' : 'provider');
      const fallbackKind = rawFallback === 'auth' ? 'disabled' : rawFallback === 'incompatible' ? 'invalid' : rawFallback;
      throw new LlmUnavailable(previousFailure?.kind ?? fallbackKind);
    } finally {
      this.release();
    }
  }
}
