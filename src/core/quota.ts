import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { transaction } from '../db/client.js';
import { product } from '../../config/product.js';
export class LlmUnavailable extends Error {
  constructor(readonly kind:'quota'|'local_limit'|'timeout'|'disabled'|'blocked'|'provider'|'invalid',readonly reason?:'global'|'personal'|'daily'|'tokens'|'message') {super(kind);}
}
export type QuotaLimits = { userRpm:number; globalRpm:number; dailyLimit:number; inputTokensPerMinute:number; reservedInputTokens?:number };
export const defaultQuotaLimits:QuotaLimits = {
  userRpm:product.llmUserRpm, globalRpm:product.llmGlobalRpm,
  dailyLimit:product.llmDailyLimit, inputTokensPerMinute:product.llmInputTokensPerMinute,
};
export async function reserveCall(db:Db,actor:string,model:string,purpose:string,reservedTokens:number|undefined=undefined,limits:QuotaLimits=defaultQuotaLimits):Promise<string>{
  const reserved = reservedTokens ?? limits.reservedInputTokens ?? product.llmReservedInputTokens;
  return transaction(db,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-llm-quota'))");
    const midnight=DateTime.now().setZone('America/Los_Angeles').startOf('day').toUTC().toISO();
    if(!Number.isSafeInteger(reserved) || reserved<=0)throw new LlmUnavailable('invalid');
    const usage=await c.query<{minute:number;daily:number;personal:number;tokens:number}>(`SELECT
      count(*) FILTER(WHERE at>clock_timestamp()-interval '1 minute')::int AS minute,
      count(*) FILTER(WHERE at>=$2)::int AS daily,
      count(*) FILTER(WHERE at>clock_timestamp()-interval '1 minute' AND actor_id=$1)::int AS personal,
      coalesce(sum(CASE WHEN input_tokens>0 THEN input_tokens ELSE reserved_input_tokens END) FILTER(WHERE at>clock_timestamp()-interval '1 minute'),0)::int AS tokens FROM llm_usage`,[actor,midnight]);
    const cooldown=await c.query('SELECT 1 FROM llm_cooldowns WHERE model=$1 AND until_at>clock_timestamp()',[model]);
    const u=usage.rows[0];
    if(!u)throw new LlmUnavailable('invalid');
    if(cooldown.rowCount)throw new LlmUnavailable('quota');
    if(u.daily>=limits.dailyLimit)throw new LlmUnavailable('local_limit','daily');
    if(u.personal>=limits.userRpm)throw new LlmUnavailable('local_limit','personal');
    if(u.minute>=limits.globalRpm)throw new LlmUnavailable('local_limit','global');
    if(u.tokens+reserved>limits.inputTokensPerMinute)throw new LlmUnavailable('local_limit','tokens');
    const row=await c.query<{id:string}>('INSERT INTO llm_usage(actor_id,model,purpose,reserved_input_tokens) VALUES($1,$2,$3,$4) RETURNING id',[actor,model,purpose,reserved]);
    return row.rows[0]!.id;
  });
}
export async function coolDown(db:Db,model:string,ms=product.llmCooldownMs):Promise<void>{
  await db.query(`INSERT INTO llm_cooldowns(model,until_at) VALUES($1,clock_timestamp()+$2::int*interval '1 millisecond')
    ON CONFLICT(model) DO UPDATE SET until_at=greatest(llm_cooldowns.until_at,excluded.until_at)`,[model,ms]);
}
