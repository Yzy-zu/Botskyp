import pino from 'pino';
import { baseRuntimeConfig, validGeminiApiKey, type Config } from '../config.js';
import { product } from '../../config/product.js';
import { LlmUnavailable } from './quota.js';

const log=pino({level:'info'});
type FailureKind='quota'|'provider'|'timeout'|'invalid'|'blocked';
/** Controlled metadata only; never attach provider bodies, credentials or a raw cause. */
export class GeminiAttemptError extends LlmUnavailable {
  constructor(kind:FailureKind,readonly status?:number,readonly retryAfterMs?:number){super(kind);}
}
export type GeminiKeyState={
  keyIndex:number;id:string;available:boolean;cooldownUntil:number;consecutive429:number;
  consecutiveErrors:number;lastUsedAt:number;requests:number;successes:number;rateLimited:number;failures:number;
  lastFailureKind?:FailureKind;
};
type PoolOptions={maxConcurrent?:number;now?:()=>number;log?:(message:string)=>void};
type Waiter={grant:()=>void;reject:()=>void};

/** Retry-After supports delta-seconds and HTTP dates. A provider delay is never shortened. */
export function retryAfterMs(value:string|null,now=Date.now()):number|undefined{
  if(!value?.trim())return undefined;
  const raw=value.trim();
  if(/^\d+(?:\.\d+)?$/.test(raw)){
    const ms=Number(raw)*1000;
    return Number.isFinite(ms)?Math.min(ms,Number.MAX_SAFE_INTEGER-now):undefined;
  }
  if(!/^[A-Za-z]{3},\s/.test(raw))return undefined;
  const date=Date.parse(raw);
  return Number.isFinite(date)?Math.max(0,date-now):undefined;
}

export class GeminiKeyPool {
  #keys:string[];
  #states:GeminiKeyState[];
  #cursor=0;
  #active=0;
  #queue:Waiter[]=[];
  #latencies:number[]=[];
  #failovers=0;
  #exhausted=0;
  #now:()=>number;
  #log:(message:string)=>void;
  readonly maxConcurrent:number;
  constructor(keys:readonly string[],options:PoolOptions={}){
    this.#keys=[...new Set(keys.map(key=>key.trim()).filter(Boolean))];
    if(!this.#keys.length || this.#keys.some(key=>!validGeminiApiKey(key)))throw new Error('Invalid configuration: GEMINI_API_KEYS / GEMINI_API_KEY');
    this.maxConcurrent=options.maxConcurrent ?? product.llmMaxConcurrentCalls;
    if(!Number.isInteger(this.maxConcurrent) || this.maxConcurrent<1 || this.maxConcurrent>product.llmMaxConfiguredConcurrency)throw new Error('Invalid configuration: LLM_MAX_CONCURRENT_CALLS');
    this.#now=options.now ?? Date.now;
    this.#log=options.log ?? (message=>log.info(message));
    this.#states=this.#keys.map((_,i)=>({keyIndex:i+1,id:`gemini-key-${i+1}`,available:true,cooldownUntil:0,consecutive429:0,consecutiveErrors:0,lastUsedAt:0,requests:0,successes:0,rateLimited:0,failures:0}));
  }
  snapshot(){
    const keys=this.#states.map(state=>({...state}));
    const latency=[...this.#latencies].sort((a,b)=>a-b);
    const percentile=(p:number)=>latency.length?latency[Math.ceil(latency.length*p)-1]!:0;
    return {configured:keys.length,healthy:keys.filter(k=>k.available).length,
      available:keys.filter(k=>k.available && k.cooldownUntil<=this.#now()).length,
      cooldown:keys.filter(k=>k.available && k.cooldownUntil>this.#now()).length,
      requests:keys.reduce((sum,k)=>sum+k.requests,0),rateLimited:keys.reduce((sum,k)=>sum+k.rateLimited,0),
      failovers:this.#failovers,exhausted:this.#exhausted,active:this.#active,queued:this.#queue.length,
      p50Ms:percentile(.5),p95Ms:percentile(.95),keys};
  }
  private select(attempted:Set<number>):GeminiKeyState|undefined{
    for(let n=0;n<this.#states.length;n++){
      const index=(this.#cursor+n)%this.#states.length;
      const key=this.#states[index]!;
      if(key.available && key.cooldownUntil<=this.#now() && !attempted.has(index)){
        this.#cursor=(index+1)%this.#states.length;
        attempted.add(index);key.lastUsedAt=this.#now();return key;
      }
    }
    return undefined;
  }
  private async acquire(signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)throw new LlmUnavailable('timeout');
    if(this.#active<this.maxConcurrent){this.#active++;return;}
    if(this.#queue.length>=product.llmMaxQueuedCalls)throw new LlmUnavailable('local_limit','concurrency');
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',waiter.reject);};
      const waiter:Waiter={grant:()=>{cleanup();resolve();},reject:()=>{
        cleanup();this.#queue=this.#queue.filter(entry=>entry!==waiter);
        reject(new LlmUnavailable(signal?.aborted?'timeout':'local_limit','concurrency'));
      }};
      const timer=setTimeout(waiter.reject,product.llmQueueWaitMs);
      signal?.addEventListener('abort',waiter.reject,{once:true});
      this.#queue.push(waiter);
    });
  }
  private release():void{
    const waiter=this.#queue.shift();
    if(waiter)waiter.grant();else this.#active--;
  }
  /** Exactly one sequential pass. The callback performs only a Gemini request, never business tools. */
  async run<T>(request:(apiKey:string,keyIndex:number)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    await this.acquire(signal);
    try{
      const attempted=new Set<number>();
      let previousFailure:LlmUnavailable|undefined;
      while(attempted.size<this.#states.length){
        if(signal?.aborted)throw new LlmUnavailable('timeout');
        const key=this.select(attempted);
        if(!key)break;
        const failover=Boolean(previousFailure);
        const start=this.#now();
        let providerAttempt=false;
        try{
          const result=await request(this.#keys[key.keyIndex-1]!,key.keyIndex);
          providerAttempt=true;
          if(failover)this.#failovers++;
          key.requests++;key.successes++;key.consecutive429=0;key.consecutiveErrors=0;
          return result;
        }catch(error){
          // Local quota/database errors are not failed provider attempts and must not rotate keys.
          if(!(error instanceof GeminiAttemptError))throw error;
          providerAttempt=true;
          if(failover)this.#failovers++;
          key.requests++;key.failures++;key.consecutiveErrors++;
          previousFailure=error;
          if(error.status===401 || error.status===403){
            key.available=false;
            this.#log(`${key.id} disabled: unauthorized`);
          }else if(error.status===429){
            key.rateLimited++;key.consecutive429++;key.lastFailureKind='quota';
            const backoff=Math.min(product.llmCooldownMs*2**Math.min(key.consecutive429-1,10),product.llmMaxCooldownMs);
            key.cooldownUntil=Math.max(key.cooldownUntil,this.#now()+(error.retryAfterMs ?? backoff));
            this.#log(`${key.id} cooldown: rate_limited`);
          }else if(error.kind==='timeout' || (error.kind==='provider' && (error.status===undefined || error.status>=500))){
            key.lastFailureKind=error.kind==='timeout'?'timeout':'provider';
            const backoff=Math.min(product.llmBackoffMs*2**Math.min(key.consecutiveErrors-1,10),product.llmCooldownMs);
            key.cooldownUntil=Math.max(key.cooldownUntil,this.#now()+(error.retryAfterMs ?? backoff));
          }else{throw error;}
        }finally{
          if(providerAttempt){
            this.#latencies.push(Math.max(0,this.#now()-start));
            if(this.#latencies.length>product.llmLatencySamples)this.#latencies.shift();
          }
        }
      }
      this.#exhausted++;
      this.#log('Gemini key pool exhausted');
      const fallbackKind = this.#states.find(k=>k.lastFailureKind)?.lastFailureKind ?? (this.#states.some(k=>k.available)?'quota':'provider');
      throw new LlmUnavailable(previousFailure?.kind ?? fallbackKind);
    }finally{this.release();}
  }
}

// One runtime Config is shared by all actors/adapters. No credentials enter public state or DB.
const pools=new WeakMap<Config,GeminiKeyPool>();
export function geminiKeyPool(config:Config):GeminiKeyPool{
  config=baseRuntimeConfig(config);
  let pool=pools.get(config);
  if(!pool){pool=new GeminiKeyPool(config.GEMINI_API_KEYS,{maxConcurrent:config.LLM_MAX_CONCURRENT_CALLS});pools.set(config,pool);}
  return pool;
}
