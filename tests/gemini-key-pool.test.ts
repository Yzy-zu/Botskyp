import { expect,it,vi } from 'vitest';
import { GeminiAttemptError, GeminiKeyPool, retryAfterMs } from '../src/core/gemini-key-pool.js';
import { LlmUnavailable } from '../src/core/quota.js';
import { product } from '../config/product.js';
const keys=['fixture-key-one','fixture-key-two','fixture-key-three'];
const quiet={log:()=>undefined};
const failure=(status:number,retry?:number)=>new GeminiAttemptError(status===429?'quota':'provider',status,retry);

it.each([1,2,3,10])('balances %i healthy keys without speculative calls',async count=>{
  const pool=new GeminiKeyPool(Array.from({length:count},(_,i)=>`fixture-key-${i}`),quiet);
  const used:number[]=[];
  for(let n=0;n<count*5;n++)await pool.run(async(_,index)=>{used.push(index);return 'ok';});
  expect(used).toEqual(Array.from({length:count*5},(_,i)=>i%count+1));
  expect(pool.snapshot().keys.map(k=>k.requests)).toEqual(Array.from({length:count},()=>5));
});
it('deduplicates trimmed keys and rejects missing/invalid configuration without values',()=>{
  expect(new GeminiKeyPool([' fixture-one ','','fixture-one','fixture-two'],quiet).snapshot().configured).toBe(2);
  for(const invalid of [[],[''],['private invalid credential']])expect(()=>new GeminiKeyPool(invalid,quiet)).toThrow('Invalid configuration: GEMINI_API_KEYS');
  expect(()=>new GeminiKeyPool(keys,{maxConcurrent:0})).toThrow('LLM_MAX_CONCURRENT_CALLS');
});
it.each([1,2])('fails over after %i rate limited keys and returns success',async limited=>{
  const pool=new GeminiKeyPool(keys,quiet);
  const request=vi.fn(async(_:string,index:number)=>{if(index<=limited)throw failure(429);return 'success';});
  expect(await pool.run(request)).toBe('success');expect(request).toHaveBeenCalledTimes(limited+1);
  expect(pool.snapshot()).toMatchObject({failovers:limited,rateLimited:limited,exhausted:0,cooldown:limited});
});
it('makes one pass when exhausted and no calls while all keys are cooling down',async()=>{
  const pool=new GeminiKeyPool(keys,quiet);
  const request=vi.fn(async()=>{throw failure(429);});
  await expect(pool.run(request)).rejects.toMatchObject({kind:'quota'});
  await expect(pool.run(request)).rejects.toMatchObject({kind:'quota'});
  expect(request).toHaveBeenCalledTimes(3);expect(pool.snapshot()).toMatchObject({exhausted:2,failovers:2});
});
it('respects Retry-After without shortening long delays, recovers and resets error streaks',async()=>{
  let now=1_000;const pool=new GeminiKeyPool([keys[0]!],{...quiet,now:()=>now});
  await expect(pool.run(async()=>{throw failure(429,3_600_000);})).rejects.toMatchObject({kind:'quota'});
  expect(pool.snapshot().keys[0]?.cooldownUntil).toBe(3_601_000);
  now+=3_599_999;
  expect(pool.snapshot().available).toBe(0);
  now++;
  expect(await pool.run(async()=> 'recovered')).toBe('recovered');
  expect(pool.snapshot().keys[0]).toMatchObject({consecutive429:0,consecutiveErrors:0,successes:1});
});
it('uses increasing bounded backoff without a provider delay',async()=>{
  let now=1_000;const pool=new GeminiKeyPool([keys[0]!],{...quiet,now:()=>now});
  for(let attempt=0;attempt<3;attempt++){
    await expect(pool.run(async()=>{throw failure(429);})).rejects.toMatchObject({kind:'quota'});
    expect(pool.snapshot().keys[0]?.cooldownUntil).toBe(now+product.llmCooldownMs*2**attempt);
    now=pool.snapshot().keys[0]!.cooldownUntil;
  }
});
it.each([401,403])('disables HTTP %i keys until process restart, without leaking credentials',async status=>{
  const messages:string[]=[];const pool=new GeminiKeyPool(keys,{log:message=>messages.push(message)});
  const request=vi.fn(async(_:string,index:number)=>{if(index===1)throw failure(status);return 'ok';});
  for(let n=0;n<6;n++)expect(await pool.run(request)).toBe('ok');
  expect(request.mock.calls.filter(([,index])=>index===1)).toHaveLength(1);
  expect(messages).toEqual(['gemini-key-1 disabled: unauthorized']);
  expect(pool.snapshot()).toMatchObject({healthy:2,available:2});
  const visible=JSON.stringify({messages,state:pool.snapshot(),instance:pool});
  for(const key of keys)expect(visible).not.toContain(key);
});
it.each([500,502,503,504,undefined])('fails over on transient error %s',async status=>{
  const pool=new GeminiKeyPool(keys,quiet);let calls=0;
  expect(await pool.run(async()=>{if(++calls===1)throw new GeminiAttemptError('provider',status);return 'ok';})).toBe('ok');
  expect(pool.snapshot()).toMatchObject({requests:2,failovers:1,cooldown:1});
});
it('fails over on timeouts but never on blocked content, invalid payloads or local limits',async()=>{
  const pool=new GeminiKeyPool(keys,quiet);let calls=0;
  await expect(pool.run(async()=>{if(++calls===1)throw new GeminiAttemptError('timeout');return 'ok';})).resolves.toBe('ok');
  for(const error of [new GeminiAttemptError('blocked'),new GeminiAttemptError('invalid'),failure(400),new LlmUnavailable('local_limit','daily')]){
    const request=vi.fn(async()=>{throw error;});
    await expect(pool.run(request)).rejects.toBe(error);expect(request).toHaveBeenCalledOnce();
  }
});
it('parses both Retry-After formats and ignores invalid values',()=>{
  const now=Date.parse('2026-10-17T00:00:00Z');
  expect(retryAfterMs('120',now)).toBe(120_000);
  expect(retryAfterMs('Sat, 17 Oct 2026 00:03:00 GMT',now)).toBe(180_000);
  expect(retryAfterMs('Sat, 17 Oct 2026 00:00:00 GMT',now+1)).toBe(0);
  for(const value of [null,'','bad','-1'])expect(retryAfterMs(value,now)).toBeUndefined();
});
it('queues bursts FIFO with bounded concurrency and releases permits after failures',async()=>{
  const pool=new GeminiKeyPool(keys,{...quiet,maxConcurrent:2});
  const releases:(()=>void)[]=[];let active=0,maxActive=0;const order:number[]=[];
  const work=Array.from({length:7},(_,index)=>pool.run(async()=>{
    active++;maxActive=Math.max(active,maxActive);order.push(index);
    await new Promise<void>(resolve=>releases.push(resolve));active--;
    if(index===2)throw new GeminiAttemptError('invalid');return index;
  }).catch(()=>-1));
  await vi.waitFor(()=>expect(releases).toHaveLength(2));expect(pool.snapshot()).toMatchObject({active:2,queued:5});
  for(let i=0;i<7;i++){
    releases[i]!();
    if(i<5)await vi.waitFor(()=>expect(releases).toHaveLength(i+3));
  }
  expect(await Promise.all(work)).toEqual([0,1,-1,3,4,5,6]);
  expect(order).toEqual([0,1,2,3,4,5,6]);expect(maxActive).toBe(2);
  expect(pool.snapshot()).toMatchObject({active:0,queued:0});
});
it('cancels queued requests and bounds queue wait without leaking a permit',async()=>{
  vi.useFakeTimers();
  try{
    const pool=new GeminiKeyPool(keys,{...quiet,maxConcurrent:1});
    let release!:()=>void;const first=pool.run(async()=>new Promise<void>(resolve=>{release=resolve;}));
    await Promise.resolve();
    const abort=new AbortController();
    const queued=pool.run(async()=>undefined,abort.signal);
    const canceled=expect(queued).rejects.toMatchObject({kind:'timeout'});abort.abort();await canceled;
    const expired=expect(pool.run(async()=>undefined)).rejects.toMatchObject({kind:'local_limit',reason:'concurrency'});
    await vi.advanceTimersByTimeAsync(product.llmQueueWaitMs);await expired;
    release();await first;
    expect(pool.snapshot()).toMatchObject({active:0,queued:0});
    expect(await pool.run(async()=> 'next')).toBe('next');
  }finally{vi.useRealTimers();}
});
it('does not fail over after the parent signal is aborted',async()=>{
  const pool=new GeminiKeyPool(keys,quiet),abort=new AbortController();
  const request=vi.fn(async()=>{abort.abort();throw new GeminiAttemptError('timeout');});
  await expect(pool.run(request,abort.signal)).rejects.toMatchObject({kind:'timeout'});expect(request).toHaveBeenCalledOnce();
});
