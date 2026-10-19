import { z } from 'zod';
import { product } from '../config/product.js';
const jid = z.string().regex(/^\d+@(s\.whatsapp\.net|lid)$/);
const list = z.string().transform(s => s.split(',').map(x => x.trim()).filter(Boolean)).pipe(z.array(jid).min(1));
export function validGeminiApiKey(key:string):boolean{return /^[\x21-\x2B\x2D-\x7E]+$/.test(key);}
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
  GEMINI_API_KEYS: z.string().default('').transform(s => [...new Set(s.split(',').map(key => key.trim()).filter(Boolean))]).pipe(z.array(z.string().refine(validGeminiApiKey))),
  GEMINI_MODEL: z.enum(['gemini-3.5-flash-lite','gemini-2.5-flash-lite','gemini-3.8-flash']).default(product.llmModel),
  GEMINI_FREE_TIER_CONFIRMED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
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
  const keys = result.data.GEMINI_API_KEYS.length ? result.data.GEMINI_API_KEYS : result.data.GEMINI_API_KEY ? [result.data.GEMINI_API_KEY] : [];
  if (!keys.length || keys.some(key => !validGeminiApiKey(key))) throw new Error('Invalid configuration: GEMINI_API_KEYS / GEMINI_API_KEY');
  if (result.data.TRANSPORT === 'evolution') {
    const db = new URL(result.data.DATABASE_URL);
    if (db.hostname !== 'botsky-db' || db.pathname !== '/botsky' || db.username !== 'botsky') {
      throw new Error('Evolution mode requires the dedicated Botsky database');
    }
  }
  // Preserve legacy Config consumers while giving the explicit LLM_* names precedence.
  return { ...result.data, GEMINI_API_KEYS: keys,
    GEMINI_USER_RPM: result.data.LLM_LOCAL_USER_RPM, LLM_USER_RPM: result.data.LLM_LOCAL_USER_RPM,
    GEMINI_GLOBAL_RPM: result.data.LLM_LOCAL_GLOBAL_RPM, LLM_GLOBAL_RPM: result.data.LLM_LOCAL_GLOBAL_RPM,
    GEMINI_DAILY_LIMIT: result.data.LLM_LOCAL_DAILY_LIMIT, LLM_DAILY_LIMIT: result.data.LLM_LOCAL_DAILY_LIMIT, GEMINI_INPUT_TPM: result.data.LLM_INPUT_TOKENS_PER_MINUTE,
  };
}

/** Legacy allowlists are parsed for rollback compatibility but never override the global mode. */
export function baseRuntimeConfig(config:Config):Config{return config;}
export function routerModeForChat(config:Config,_chatId:string):Config['ROUTER_MODE']{void _chatId;return config.ROUTER_MODE;}
export function configForChat(config:Config,_chatId:string):Config{void _chatId;return config;}
