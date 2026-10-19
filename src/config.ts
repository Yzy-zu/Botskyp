import { z } from 'zod';
import { product } from '../config/product.js';
const jid = z.string().regex(/^\d+@(s\.whatsapp\.net|lid)$/);
const list = z.string().transform(s => s.split(',').map(x => x.trim()).filter(Boolean)).pipe(z.array(jid).min(1));
export function validGeminiApiKey(key:string):boolean{return /^[\x21-\x2B\x2D-\x7E]+$/.test(key);}
export function validApiKey(key:string):boolean{return /^[\x21-\x7E]+$/.test(key);}

export function mergeAndDedupeApiKeys(singular?: string, plural?: string | readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const processItem = (item?: string) => {
    if (!item) return;
    const parts = item.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  };

  processItem(singular);
  if (Array.isArray(plural)) {
    for (const p of plural) {
      processItem(p);
    }
  } else if (typeof plural === 'string') {
    processItem(plural);
  }

  return result;
}

const localLimit = (max:number, fallback:number) => z.string().trim().min(1).transform(Number).pipe(z.number().int().min(0).max(max)).default(fallback);
const schema = z.object({
  OBSERVER_ENABLED: z.enum(['true','false']).default('false').catch('false').transform(s=>s==='true'),
  OBSERVER_SPOOL_DIR: z.string().min(1).default('/var/lib/botsky-observer/spool').catch('/var/lib/botsky-observer/spool'),
  OBSERVER_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7).catch(7),
  OBSERVER_MAX_SPOOL_MB: z.coerce.number().int().min(1).max(10240).default(512).catch(512),
  ROUTER_MODE: z.enum(['v1','v1_1_shadow','v1_1']).default('v1_1'),
  TOOL_CALLING_MODE: z.enum(['full_96', 'dynamic']).default('dynamic'),
  ROUTER_V1_1_CHAT_IDS: z.unknown().transform(():string[]|undefined=>undefined).optional(),
  GEMINI_USER_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmUserRpm),
  GEMINI_GLOBAL_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmGlobalRpm),
  GEMINI_DAILY_LIMIT: localLimit(product.llmMaxConfiguredDaily, product.llmDailyLimit),
  GEMINI_INPUT_TPM: localLimit(product.llmMaxConfiguredTokens, product.llmInputTokensPerMinute),
  LLM_USER_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmUserRpm),
  LLM_GLOBAL_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmGlobalRpm),
  LLM_DAILY_LIMIT: localLimit(product.llmMaxConfiguredDaily, product.llmDailyLimit),
  LLM_INPUT_TOKENS_PER_MINUTE: localLimit(product.llmMaxConfiguredTokens, product.llmInputTokensPerMinute),
  LLM_RESERVED_INPUT_TOKENS: z.coerce.number().int().min(1).max(product.llmMaxConfiguredTokens).default(product.llmReservedInputTokens),
  LLM_LOCAL_USER_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmUserRpm),
  LLM_LOCAL_GLOBAL_RPM: localLimit(product.llmMaxConfiguredRpm, product.llmGlobalRpm),
  LLM_LOCAL_DAILY_LIMIT: localLimit(product.llmMaxConfiguredDaily, product.llmDailyLimit),
  LLM_MAX_CONCURRENT_CALLS: z.string().trim().min(1).transform(Number).pipe(z.number().int().min(1).max(product.llmMaxConfiguredConcurrency)).default(product.llmMaxConcurrentCalls),
  DRIVE_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  LIBRARY_DRIVE_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  MINECRAFT_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  GEMINI_API_KEY: z.string().trim().default(''),
  GEMINI_API_KEYS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(key => key.trim()).filter(Boolean))]),
  GEMINI_MODEL: z.enum(['gemini-3.5-flash-lite','gemini-2.5-flash-lite','gemini-3.8-flash']).default(product.llmModel),
  GEMINI_MODELS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(m => m.trim()).filter(Boolean))]),
  GEMINI_FREE_TIER_CONFIRMED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  GROQ_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  GROQ_API_KEY: z.string().trim().default(''),
  GROQ_API_KEYS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(key => key.trim()).filter(Boolean))]),
  GROQ_MODELS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(m => m.trim()).filter(Boolean))]),
  OPENROUTER_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  OPENROUTER_API_KEY: z.string().trim().default(''),
  OPENROUTER_API_KEYS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(key => key.trim()).filter(Boolean))]),
  OPENROUTER_MODELS: z.union([z.string(), z.array(z.string())]).default('').transform(s => Array.isArray(s) ? s : [...new Set(s.split(',').map(m => m.trim()).filter(Boolean))]),
  OPENROUTER_ALLOW_FREE_MODELS: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  LLM_ROUTE: z.string().default(''),
  LLM_MAX_PROVIDER_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  QUALIFICATION_MANIFEST_PATH: z.string().default('var/llm-qualified-models.json'),
  WEB_SEARCH_PROVIDER: z.enum(['searxng','gemini']).default('searxng'),
  SEARXNG_URL: z.url().default('http://searxng:8080'),
  DATABASE_URL: z.url().refine(s => s.startsWith('postgresql://') || s.startsWith('postgres://')),
  EVOLUTION_URL: z.url(), EVOLUTION_APIKEY: z.string().min(1),
  INSTANCE: z.string().regex(/^[\w-]+$/), WEBHOOK_SECRET: z.string().min(32),
  OWNER_JIDS: list, BOT_JIDS: list,
  LAB_CHAT_ID: z.string().regex(/^\d+@g\.us$/),
  TRANSPORT: z.enum(['evolution', 'mock']).default('mock'),
  STALE_SECONDS: z.coerce.number().int().positive().default(product.staleSeconds),
  TZ_DEFAULT: z.string().default('America/Mexico_City').refine(s => { try { new Intl.DateTimeFormat('en', { timeZone:s }); return true; } catch { return false; } }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CAPTURE_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse({
    ...env,
    LLM_LOCAL_USER_RPM: env.LLM_LOCAL_USER_RPM ?? env.LLM_USER_RPM ?? env.GEMINI_USER_RPM,
    LLM_LOCAL_GLOBAL_RPM: env.LLM_LOCAL_GLOBAL_RPM ?? env.LLM_GLOBAL_RPM ?? env.GEMINI_GLOBAL_RPM,
    LLM_LOCAL_DAILY_LIMIT: env.LLM_LOCAL_DAILY_LIMIT ?? env.LLM_DAILY_LIMIT ?? env.GEMINI_DAILY_LIMIT,
    LLM_INPUT_TOKENS_PER_MINUTE: env.LLM_INPUT_TOKENS_PER_MINUTE ?? env.GEMINI_INPUT_TPM,
  });
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const keys = mergeAndDedupeApiKeys(
    (env.GEMINI_API_KEY as string | undefined) ?? result.data.GEMINI_API_KEY,
    (env.GEMINI_API_KEYS as string | string[] | undefined) ?? result.data.GEMINI_API_KEYS,
  );
  if (!keys.length || keys.some(key => !validGeminiApiKey(key))) throw new Error('Invalid configuration: GEMINI_API_KEYS / GEMINI_API_KEY');

  const groqKeys = mergeAndDedupeApiKeys(
    (env.GROQ_API_KEY as string | undefined) ?? result.data.GROQ_API_KEY,
    (env.GROQ_API_KEYS as string | string[] | undefined) ?? result.data.GROQ_API_KEYS,
  );
  if (result.data.GROQ_ENABLED && (!groqKeys.length || groqKeys.some(key => !validApiKey(key)))) {
    throw new Error('Invalid configuration: GROQ_API_KEYS / GROQ_API_KEY');
  }

  const openRouterKeys = mergeAndDedupeApiKeys(
    (env.OPENROUTER_API_KEY as string | undefined) ?? result.data.OPENROUTER_API_KEY,
    (env.OPENROUTER_API_KEYS as string | string[] | undefined) ?? result.data.OPENROUTER_API_KEYS,
  );
  if (result.data.OPENROUTER_ENABLED && (!openRouterKeys.length || openRouterKeys.some(key => !validApiKey(key)))) {
    throw new Error('Invalid configuration: OPENROUTER_API_KEYS / OPENROUTER_API_KEY');
  }

  const geminiModels = result.data.GEMINI_MODELS.length ? result.data.GEMINI_MODELS : [result.data.GEMINI_MODEL];
  const groqModels = result.data.GROQ_MODELS.length ? result.data.GROQ_MODELS : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  const openRouterModels = result.data.OPENROUTER_MODELS.length ? result.data.OPENROUTER_MODELS : ['meta-llama/llama-3.3-70b-instruct'];

  if (result.data.TRANSPORT === 'evolution') {
    const db = new URL(result.data.DATABASE_URL);
    if (db.hostname !== 'botsky-db' || db.pathname !== '/botsky' || db.username !== 'botsky') {
      throw new Error('Evolution mode requires the dedicated Botsky database');
    }
  }
  // Preserve legacy Config consumers while giving the explicit LLM_* names precedence.
  return {
    ...result.data,
    GEMINI_API_KEY: keys[0] ?? '',
    GEMINI_API_KEYS: keys,
    GROQ_API_KEY: groqKeys[0] ?? '',
    GROQ_API_KEYS: groqKeys,
    OPENROUTER_API_KEY: openRouterKeys[0] ?? '',
    OPENROUTER_API_KEYS: openRouterKeys,
    GEMINI_MODELS: geminiModels,
    GROQ_MODELS: groqModels,
    OPENROUTER_MODELS: openRouterModels,
    GEMINI_USER_RPM: result.data.LLM_LOCAL_USER_RPM,
    LLM_USER_RPM: result.data.LLM_LOCAL_USER_RPM,
    GEMINI_GLOBAL_RPM: result.data.LLM_LOCAL_GLOBAL_RPM,
    LLM_GLOBAL_RPM: result.data.LLM_LOCAL_GLOBAL_RPM,
    GEMINI_DAILY_LIMIT: result.data.LLM_LOCAL_DAILY_LIMIT,
    LLM_DAILY_LIMIT: result.data.LLM_LOCAL_DAILY_LIMIT,
    GEMINI_INPUT_TPM: result.data.LLM_INPUT_TOKENS_PER_MINUTE,
  };
}

/** Legacy allowlists are parsed for rollback compatibility but never override the global mode. */
export function baseRuntimeConfig(config:Config):Config{return config;}
export function routerModeForChat(config:Config,_chatId:string):Config['ROUTER_MODE']{void _chatId;return config.ROUTER_MODE;}
export function configForChat(config:Config,_chatId:string):Config{void _chatId;return config;}
