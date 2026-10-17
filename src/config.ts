import { z } from 'zod';
import { product } from '../config/product.js';
const jid = z.string().regex(/^\d+@(s\.whatsapp\.net|lid)$/);
const list = z.string().transform(s => s.split(',').map(x => x.trim()).filter(Boolean)).pipe(z.array(jid).min(1));
const schema = z.object({
  DRIVE_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  LIBRARY_DRIVE_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  MINECRAFT_ENABLED: z.enum(['true','false']).default('false').transform(s => s === 'true'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.enum(['gemini-3.5-flash-lite','gemini-2.5-flash-lite']).default(product.llmModel),
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
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  if (result.data.TRANSPORT === 'evolution') {
    const db = new URL(result.data.DATABASE_URL);
    if (db.hostname !== 'botsky-db' || db.pathname !== '/botsky' || db.username !== 'botsky') {
      throw new Error('Evolution mode requires the dedicated Botsky database');
    }
  }
  return result.data;
}
