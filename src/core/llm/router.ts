import { observer } from '../../observer/index.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { product } from '../../../config/product.js';
import { LlmUnavailable, reserveCall } from '../quota.js';
import type {
  CandidateHealthState,
  Llm,
  LlmInput,
  LlmReply,
  OperationalHealth,
  ProviderId,
  RouteCandidate,
  TurnFallbackLog,
} from './types.js';
import { TurnLlmBudget } from './types.js';
import { getModelCapability } from './capability-matrix.js';
import { tokenPreflight } from './preflight.js';
import { CredentialPool, ProviderAttemptError } from './credential-pool.js';
import type { LlmProviderAdapter } from './provider-adapter.js';
import { GeminiProvider } from './gemini-adapter.js';
import { GroqProvider } from './groq-adapter.js';
import { OpenRouterProvider } from './openrouter-adapter.js';

export type RouterOptions = {
  db?: Db | undefined;
  actor?: string | undefined;
  now?: (() => number) | undefined;
  http?: typeof fetch | undefined;
  parentSignal?: AbortSignal | undefined;
};

export function parseRouteCandidate(entry: string): { provider: ProviderId; model?: string } | undefined {
  const trimmed = entry.trim();
  if (!trimmed) return undefined;

  let providerStr: string;
  let modelStr: string | undefined;

  if (trimmed.includes('|')) {
    const idx = trimmed.indexOf('|');
    providerStr = trimmed.slice(0, idx).trim().toLowerCase();
    modelStr = trimmed.slice(idx + 1).trim();
  } else if (/^(gemini|groq|openrouter)[:/]/i.test(trimmed)) {
    const match = trimmed.match(/^(gemini|groq|openrouter)[:/](.+)$/i);
    if (match) {
      providerStr = match[1]!.toLowerCase();
      modelStr = match[2]!.trim();
    } else {
      return undefined;
    }
  } else {
    providerStr = trimmed.toLowerCase();
    modelStr = undefined;
  }

  if (!['gemini', 'groq', 'openrouter'].includes(providerStr)) return undefined;
  return {
    provider: providerStr as ProviderId,
    ...(modelStr ? { model: modelStr } : {}),
  };
}

export class MultiProviderRouter implements Llm {
  readonly counters = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly config: Config;
  private db?: Db | undefined;
  private readonly actor: string;
  private readonly now: () => number;
  private readonly http: typeof fetch;
  private readonly parentSignal?: AbortSignal | undefined;

  setDb(db: Db): void {
    this.db = db;
  }

  hasDb(): boolean {
    return Boolean(this.db);
  }

  private readonly pools = new Map<ProviderId, CredentialPool>();
  private readonly adapters = new Map<ProviderId, LlmProviderAdapter>();
  private readonly healthMap = new Map<string, CandidateHealthState>();
  private readonly turnBudgets = new Map<string, TurnLlmBudget>();
  private stickyCandidate: RouteCandidate | undefined;

  constructor(config: Config, options: RouterOptions = {}) {
    this.config = config;
    this.db = options.db;
    this.actor = options.actor ?? 'anonymous';
    this.now = options.now ?? Date.now;
    this.http = options.http ?? fetch;
    this.parentSignal = options.parentSignal;

    this.initializeProviders();
  }

  private initializeProviders(): void {
    // 1. Gemini
    const geminiKeys = this.config.GEMINI_API_KEYS.length
      ? this.config.GEMINI_API_KEYS
      : this.config.GEMINI_API_KEY ? [this.config.GEMINI_API_KEY] : [];
    if (geminiKeys.length) {
      this.pools.set('gemini', new CredentialPool(geminiKeys, {
        providerPrefix: 'gemini',
        maxConcurrent: this.config.LLM_MAX_CONCURRENT_CALLS,
        now: this.now,
      }));
    }
    const geminiModels = this.config.GEMINI_MODELS?.length
      ? this.config.GEMINI_MODELS
      : [this.config.GEMINI_MODEL];
    this.adapters.set('gemini', new GeminiProvider(geminiModels, this.http));

    // 2. Groq
    const groqKeys = this.config.GROQ_API_KEYS?.length
      ? this.config.GROQ_API_KEYS
      : this.config.GROQ_API_KEY ? [this.config.GROQ_API_KEY] : [];
    if (groqKeys.length) {
      this.pools.set('groq', new CredentialPool(groqKeys, {
        providerPrefix: 'groq',
        maxConcurrent: this.config.LLM_MAX_CONCURRENT_CALLS,
        now: this.now,
      }));
    }
    const groqModels = this.config.GROQ_MODELS?.length
      ? this.config.GROQ_MODELS
      : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    this.adapters.set('groq', new GroqProvider(groqModels, this.http));

    // 3. OpenRouter
    const openRouterKeys = this.config.OPENROUTER_API_KEYS?.length
      ? this.config.OPENROUTER_API_KEYS
      : this.config.OPENROUTER_API_KEY ? [this.config.OPENROUTER_API_KEY] : [];
    if (openRouterKeys.length) {
      this.pools.set('openrouter', new CredentialPool(openRouterKeys, {
        providerPrefix: 'openrouter',
        maxConcurrent: this.config.LLM_MAX_CONCURRENT_CALLS,
        now: this.now,
      }));
    }
    const openRouterModels = this.config.OPENROUTER_MODELS?.length
      ? this.config.OPENROUTER_MODELS
      : ['meta-llama/llama-3.3-70b-instruct'];
    this.adapters.set('openrouter', new OpenRouterProvider(
      openRouterModels,
      this.config.OPENROUTER_ALLOW_FREE_MODELS ?? false,
      this.http,
    ));
  }

  getPool(provider: ProviderId): CredentialPool | undefined {
    return this.pools.get(provider);
  }

  getAdapter(provider: ProviderId): LlmProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  getOrCreateBudget(turnId?: string): TurnLlmBudget {
    const maxAttempts = this.config.LLM_MAX_PROVIDER_ATTEMPTS ?? 3;
    if (turnId) {
      let b = this.turnBudgets.get(turnId);
      if (!b) {
        b = new TurnLlmBudget(maxAttempts, turnId);
        this.turnBudgets.set(turnId, b);
      }
      return b;
    }
    return new TurnLlmBudget(maxAttempts);
  }

  reset(): void {
    for (const pool of this.pools.values()) {
      pool.reset();
    }
    this.healthMap.clear();
    this.stickyCandidate = undefined;
    this.turnBudgets.clear();
  }

  async search(query: string, turnId?: string): Promise<string> {
    const pool = this.pools.get('gemini');
    const adapter = this.adapters.get('gemini') as GeminiProvider | undefined;
    if (!pool || !adapter) throw new LlmUnavailable('disabled');
    return pool.run(async (apiKey) => {
      return adapter.search(query, apiKey, turnId, this.parentSignal);
    }, this.parentSignal);
  }

  getConfiguredCandidates(): RouteCandidate[] {
    const rawRoute = this.config.LLM_ROUTE?.trim();
    const candidates: RouteCandidate[] = [];

    if (rawRoute) {
      const entries = rawRoute.split(',').map(s => s.trim()).filter(Boolean);
      let priority = 10;
      for (const entry of entries) {
        const parsed = parseRouteCandidate(entry);
        if (!parsed) continue;

        let model = parsed.model;
        if (!model || model === 'preferred') {
          if (parsed.provider === 'gemini') {
            model = this.config.GEMINI_MODELS?.[0] || this.config.GEMINI_MODEL;
          } else if (parsed.provider === 'groq') {
            model = this.config.GROQ_MODELS?.[0] || 'llama-3.3-70b-versatile';
          } else if (parsed.provider === 'openrouter') {
            model = this.config.OPENROUTER_MODELS?.[0] || 'meta-llama/llama-3.3-70b-instruct';
          }
        }

        const isEnabled = parsed.provider === 'gemini'
          ? Boolean(this.config.GEMINI_FREE_TIER_CONFIRMED && this.pools.get('gemini')?.keyCount)
          : parsed.provider === 'groq'
            ? Boolean(this.config.GROQ_ENABLED && this.pools.get('groq')?.keyCount)
            : Boolean(this.config.OPENROUTER_ENABLED && this.pools.get('openrouter')?.keyCount);

        candidates.push({
          provider: parsed.provider,
          model: model!,
          priority,
          enabled: isEnabled,
        });
        priority += 10;
      }
    }

    if (!candidates.length) {
      // Default deterministic priority order: Gemini -> Groq -> OpenRouter
      const geminiModels = this.config.GEMINI_MODELS?.length
        ? this.config.GEMINI_MODELS
        : [this.config.GEMINI_MODEL];
      let prio = 10;
      for (const m of geminiModels) {
        candidates.push({
          provider: 'gemini',
          model: m,
          priority: prio,
          enabled: Boolean(this.config.GEMINI_FREE_TIER_CONFIRMED && this.pools.get('gemini')?.keyCount),
        });
        prio += 10;
      }

      const groqModels = this.config.GROQ_MODELS?.length
        ? this.config.GROQ_MODELS
        : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
      for (const m of groqModels) {
        candidates.push({
          provider: 'groq',
          model: m,
          priority: prio,
          enabled: Boolean(this.config.GROQ_ENABLED && this.pools.get('groq')?.keyCount),
        });
        prio += 10;
      }

      const openRouterModels = this.config.OPENROUTER_MODELS?.length
        ? this.config.OPENROUTER_MODELS
        : ['meta-llama/llama-3.3-70b-instruct'];
      for (const m of openRouterModels) {
        candidates.push({
          provider: 'openrouter',
          model: m,
          priority: prio,
          enabled: Boolean(this.config.OPENROUTER_ENABLED && this.pools.get('openrouter')?.keyCount),
        });
        prio += 10;
      }
    }

    return candidates;
  }


  private getCandidateHealth(provider: ProviderId, credentialId: string, model: string): CandidateHealthState {
    const key = `${provider}:${credentialId}:${model}`;
    let state = this.healthMap.get(key);
    if (!state) {
      state = {
        provider,
        credentialId,
        model,
        status: 'healthy',
        lastSuccessAt: 0,
        lastFailureAt: 0,
        consecutive429: 0,
        consecutiveErrors: 0,
        cooldownUntil: 0,
        lastLatencyMs: 0,
      };
      this.healthMap.set(key, state);
    }
    return state;
  }

  getHealthSnapshot(): readonly CandidateHealthState[] {
    return Array.from(this.healthMap.values());
  }

  private isCandidateOperational(candidate: RouteCandidate, credentialId: string): OperationalHealth {
    if (!candidate.enabled) return 'disabled';
    const pool = this.pools.get(candidate.provider);
    if (!pool) return 'disabled';

    const credState = pool.getState(credentialId);
    if (!credState?.available) return 'disabled';
    if (credState.cooldownUntil > this.now()) return 'cooldown';

    const candHealth = this.getCandidateHealth(candidate.provider, credentialId, candidate.model);
    if (candHealth.cooldownUntil > this.now()) return 'cooldown';
    if (candHealth.status === 'disabled') return 'disabled';

    return 'healthy';
  }

  async generate(input: LlmInput): Promise<LlmReply> {
    const budget = input.turnBudget ?? this.getOrCreateBudget(input.turnId);
    budget.generationIndex++;

    const fallbackLog: TurnFallbackLog = {
      turnId: budget.turnId,
      attempts: budget.fallbackAttempts,
      success: false,
    };

    let configuredCandidates = this.getConfiguredCandidates();

    // Stickiness: If we succeeded on a candidate earlier in this turn, try it first
    const activeSticky = input.turnBudget?.stickyCandidate ?? this.stickyCandidate;
    if (activeSticky) {
      configuredCandidates = [
        activeSticky,
        ...configuredCandidates.filter(c => !(c.provider === activeSticky.provider && c.model === activeSticky.model)),
      ];
    }

    const actor = input.actor ?? this.actor ?? 'anonymous';

    for (const candidate of configuredCandidates) {
      if (!budget.canAttempt()) break;
      if (!candidate.enabled) continue;

      // Cross-provider continuation check (Section 13):
      // If the turn already executed tool calls using OpenRouter or Groq, never switch to Gemini mid-turn!
      if (budget.initialOpenAiFormat && candidate.provider === 'gemini') {
        continue;
      }

      const pool = this.pools.get(candidate.provider);
      const adapter = this.adapters.get(candidate.provider);
      if (!pool || !adapter) continue;

      // Section 5: Router MUST enforce candidate.adapter.canHandle(input, candidate.model) before network!
      if (!adapter.canHandle(input, candidate.model)) {
        budget.fallbackAttempts.push({
          ordinal: budget.actualNetworkAttempts + 1,
          provider: candidate.provider,
          credentialId: 'n/a',
          model: candidate.model,
          result: 'preflight_skipped',
          skipReason: 'CANNOT_HANDLE',
        });
        continue;
      }

      budget.sawCompatibleCandidate = true;

      // Token Preflight: Check context window and limits before network call
      const cap = getModelCapability(candidate.provider, candidate.model);
      const preflight = tokenPreflight(cap, input);
      if (!preflight.ok) {
        budget.fallbackAttempts.push({
          ordinal: budget.actualNetworkAttempts + 1,
          provider: candidate.provider,
          credentialId: 'n/a',
          model: candidate.model,
          result: 'preflight_skipped',
          skipReason: preflight.reason,
        });
        continue;
      }

      // Check available credentials in the pool
      for (const credState of pool.states) {
        if (!budget.canAttempt()) break;

        const health = this.isCandidateOperational(candidate, credState.id);
        if (health !== 'healthy') {
          continue;
        }

        const candHealth = this.getCandidateHealth(candidate.provider, credState.id, candidate.model);

        // HARD INVARIANT: Network attempt is incremented BEFORE every actual HTTP request (Section 3 & 14)
        const attemptOrdinal = budget.recordAttempt();
        const started = this.now();

        observer.emit(() => ({
          eventType: 'LLM_ATTEMPT_STARTED',
          stage: `${candidate.provider}.router`,
          payload: {
            turnId: budget.turnId,
            generationIndex: budget.generationIndex,
            attemptGlobal: attemptOrdinal,
            provider: candidate.provider,
            credentialId: credState.id,
            model: candidate.model,
          },
        }));

        let usageId: string | undefined;
        if (this.db) {
          usageId = await reserveCall(
            this.db,
            actor,
            candidate.model,
            'router',
            preflight.estimatedTokens,
            {
              userRpm: this.config.LLM_LOCAL_USER_RPM,
              globalRpm: this.config.LLM_LOCAL_GLOBAL_RPM,
              dailyLimit: this.config.LLM_LOCAL_DAILY_LIMIT,
              inputTokensPerMinute: this.config.LLM_INPUT_TOKENS_PER_MINUTE,
              reservedInputTokens: this.config.LLM_RESERVED_INPUT_TOKENS,
            },
            input.turnId,
          );
        }

        try {
          const reply = await pool.executeKey(credState.keyIndex, async (apiKey, _keyIndex, credId) => {
            return adapter.generate(input, candidate.model, apiKey, credId, this.parentSignal);
          }, this.parentSignal);

          const latencyMs = Math.max(0, this.now() - started);
          candHealth.lastSuccessAt = this.now();
          candHealth.consecutive429 = 0;
          candHealth.consecutiveErrors = 0;
          candHealth.lastLatencyMs = latencyMs;
          candHealth.status = 'healthy';

          this.counters.calls++;
          this.counters.inputTokens += reply.usage?.inputTokens ?? 0;
          this.counters.outputTokens += reply.usage?.outputTokens ?? 0;

          if (this.db && usageId) {
            await this.db.query(
              'UPDATE llm_usage SET status=$2, input_tokens=$3, output_tokens=$4 WHERE id=$1',
              [usageId, 'ok', reply.usage?.inputTokens ?? 0, reply.usage?.outputTokens ?? 0],
            ).catch(() => undefined);
          }

          this.stickyCandidate = candidate;
          if (input.turnBudget) {
            input.turnBudget.stickyCandidate = candidate;
          }
          if (candidate.provider !== 'gemini' && reply.calls && reply.calls.length > 0) {
            budget.initialOpenAiFormat = true;
          }

          budget.fallbackAttempts.push({
            ordinal: attemptOrdinal,
            provider: candidate.provider,
            credentialId: credState.id,
            model: candidate.model,
            result: 'success',
            latencyMs,
          });
          fallbackLog.finalProvider = candidate.provider;
          fallbackLog.finalModel = candidate.model;
          fallbackLog.success = true;

          observer.emit(() => ({
            eventType: 'ROUTER_METRICS',
            stage: 'router.fallback',
            ...(budget.turnId ? { turnId: budget.turnId } : {}),
            payload: {
              ...fallbackLog,
              actualNetworkAttempts: budget.actualNetworkAttempts,
            },
          }));

          return reply;
        } catch (error) {
          budget.lastError = error;
          const latencyMs = Math.max(0, this.now() - started);
          candHealth.lastFailureAt = this.now();
          candHealth.lastLatencyMs = latencyMs;

          let failureKind: string = 'provider';
          let httpStatus: number | undefined;

          if (error instanceof ProviderAttemptError) {
            failureKind = error.failureKind;
            httpStatus = error.status;
          } else if (error instanceof LlmUnavailable) {
            failureKind = error.kind;
          }

          if (failureKind === 'quota' || httpStatus === 429) {
            budget.sawRateLimit = true;
            candHealth.consecutive429++;
            const backoff = Math.min(product.llmCooldownMs * 2 ** Math.min(candHealth.consecutive429 - 1, 10), product.llmMaxCooldownMs);
            candHealth.cooldownUntil = Math.max(candHealth.cooldownUntil, this.now() + backoff);
            candHealth.status = 'cooldown';
          } else if (failureKind === 'auth' || httpStatus === 401) {
            budget.sawAuthFailure = true;
            candHealth.status = 'disabled';
            pool.disable(credState.id);
          } else {
            candHealth.consecutiveErrors++;
            candHealth.cooldownUntil = Math.max(candHealth.cooldownUntil, this.now() + 10_000);
          }

          if (this.db && usageId) {
            await this.db.query(
              'UPDATE llm_usage SET status=$2 WHERE id=$1',
              [usageId, failureKind === 'quota' ? 'http_429' : `http_${httpStatus ?? 'error'}`],
            ).catch(() => undefined);
          }

          budget.fallbackAttempts.push({
            ordinal: attemptOrdinal,
            provider: candidate.provider,
            credentialId: credState.id,
            model: candidate.model,
            result: failureKind === 'quota' ? 'quota'
              : failureKind === 'auth' ? 'auth'
                : failureKind === 'timeout' ? 'timeout'
                  : failureKind === 'blocked' ? 'blocked'
                    : failureKind === 'invalid' ? 'invalid'
                      : 'provider',
            httpStatus,
            latencyMs,
          });

          // Stickiness reset if sticky candidate fails
          if (this.stickyCandidate && this.stickyCandidate.provider === candidate.provider && this.stickyCandidate.model === candidate.model) {
            this.stickyCandidate = undefined;
          }
          if (input.turnBudget?.stickyCandidate && input.turnBudget.stickyCandidate.provider === candidate.provider && input.turnBudget.stickyCandidate.model === candidate.model) {
            input.turnBudget.stickyCandidate = undefined;
          }

          // Non-retryable errors per Section 4:
          if (failureKind === 'blocked') {
            throw error;
          }
          if (failureKind === 'invalid') {
            throw error;
          }
          if (error instanceof LlmUnavailable && error.kind === 'local_limit') {
            throw error;
          }

          // Otherwise continue to next viable candidate/credential within budget!
        }
      }
    }

    fallbackLog.success = false;
    observer.emit(() => ({
      eventType: 'ROUTER_METRICS',
      stage: 'router.fallback',
      ...(budget.turnId ? { turnId: budget.turnId } : {}),
      payload: {
        ...fallbackLog,
        actualNetworkAttempts: budget.actualNetworkAttempts,
      },
    }));

    if (!budget.sawCompatibleCandidate) {
      throw new LlmUnavailable('invalid'); // NO_COMPATIBLE_PROVIDER
    }
    if (budget.sawRateLimit) {
      throw new LlmUnavailable('quota'); // ALL_PROVIDERS_RATE_LIMITED
    }
    if (budget.sawAuthFailure) {
      throw new LlmUnavailable('disabled'); // AUTH_CONFIGURATION_ERROR
    }

    if (budget.lastError instanceof LlmUnavailable) throw budget.lastError;
    throw new LlmUnavailable('provider'); // ALL_PROVIDERS_UNAVAILABLE
  }
}

let sharedRouterInstance: MultiProviderRouter | undefined;
let sharedRouterConfig: Config | undefined;

export function getSharedMultiProviderRouter(config: Config, options?: RouterOptions): MultiProviderRouter {
  if (!sharedRouterInstance || sharedRouterConfig !== config) {
    sharedRouterInstance = new MultiProviderRouter(config, options);
    sharedRouterConfig = config;
  } else if (options?.db && !sharedRouterInstance.hasDb()) {
    sharedRouterInstance.setDb(options.db);
  }
  return sharedRouterInstance;
}

export function setSharedMultiProviderRouter(router: MultiProviderRouter | undefined): void {
  sharedRouterInstance = router;
}

export function resetSharedMultiProviderRouter(): void {
  if (sharedRouterInstance) {
    sharedRouterInstance.reset();
  }
  sharedRouterInstance = undefined;
  sharedRouterConfig = undefined;
}

