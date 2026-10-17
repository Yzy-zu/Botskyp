import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { transaction } from '../db/client.js';
import { product } from '../../config/product.js';
export class LlmUnavailable extends Error {
  constructor(readonly kind:'quota'|'local_limit'|'timeout'|'disabled'|'blocked'|'provider'|'invalid',readonly reason?:'global'|'personal'|'daily'|'tokens'|'message'|'concurrency') {super(kind);}
}
export type QuotaLimits = { userRpm:number; globalRpm:number; dailyLimit:number; inputTokensPerMinute:number; reservedInputTokens?:number };
export const defaultQuotaLimits:QuotaLimits = {
  userRpm:product.llmUserRpm, globalRpm:product.llmGlobalRpm,
  dailyLimit:product.llmDailyLimit, inputTokensPerMinute:product.llmInputTokensPerMinute,
};
export async function reserveCall(db:Db,actor:string,model:string,purpose:string,reservedTokens:number|undefined=undefined,limits:QuotaLimits=defaultQuotaLimits,turnId?:string):Promise<string>{
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
    const u=usage.rows[0];
    if(!u)throw new LlmUnavailable('invalid');
    if(limits.dailyLimit>0 && u.daily>=limits.dailyLimit)throw new LlmUnavailable('local_limit','daily');
    if(limits.userRpm>0 && u.personal>=limits.userRpm)throw new LlmUnavailable('local_limit','personal');
    if(limits.globalRpm>0 && u.minute>=limits.globalRpm)throw new LlmUnavailable('local_limit','global');
    if(limits.inputTokensPerMinute>0 && u.tokens+reserved>limits.inputTokensPerMinute)throw new LlmUnavailable('local_limit','tokens');
    const row=await c.query<{id:string}>('INSERT INTO llm_usage(actor_id,model,purpose,reserved_input_tokens,turn_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[actor,model,purpose,reserved,turnId ?? null]);
    return row.rows[0]!.id;
  });
}
