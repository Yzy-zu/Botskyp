import { readFileSync } from 'node:fs';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { Gemini,estimateInputTokens } from '../src/core/llm.js';
import { defaultQuotaLimits, reserveCall } from '../src/core/quota.js';
import { product } from '../config/product.js';
import { searxSearch } from '../src/modules/web/index.js';
import { currentImage } from '../src/wa/media.js';
import type { Msg } from '../src/wa/types.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
const db=createDb(url);
let config=readConfig({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock',GEMINI_API_KEY:'test-key-never-log',GEMINI_FREE_TIER_CONFIRMED:'true'});
const input={system:'Sistema',contents:[{role:'user',parts:[{text:'hola'}]}],tools:[]};
const success=()=>Response.json({candidates:[{content:{role:'model',parts:[{text:'Hola, perrillo.'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:5}});
beforeAll(()=>migrate(db));afterAll(()=>db.end());beforeEach(()=>{config={...config};return db.query('TRUNCATE llm_usage,llm_cooldowns').then(()=>undefined);});
it('uses a fixed Google endpoint, header auth, typed payload and persistent accounting',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());const llm=new Gemini(db,config,'actor',{used:0},http);
  expect((await llm.generate(input)).text).toBe('Hola, perrillo.');
  const [endpoint,init]=http.mock.calls[0]!;expect(endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  expect(String(endpoint)).not.toContain(config.GEMINI_API_KEY);expect(init?.headers).toHaveProperty('x-goog-api-key',config.GEMINI_API_KEY);
  const usage=(await db.query('SELECT status,input_tokens,output_tokens FROM llm_usage')).rows[0];expect(usage).toEqual({status:'ok',input_tokens:12,output_tokens:5});
});
it('quota reservations are atomic and persist across adapter instances',async()=>{
  const limits={...defaultQuotaLimits,inputTokensPerMinute:65_536};
  const results=await Promise.allSettled(Array.from({length:5},()=>reserveCall(db,'actor',config.GEMINI_MODEL,'test',undefined,limits)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  const http=vi.fn<typeof fetch>(async()=>success());await expect(new Gemini(db,{...config,LLM_INPUT_TOKENS_PER_MINUTE:65_536},'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});expect(http).not.toHaveBeenCalled();
});
it('single-key 429 opens an in-memory cooldown without retrying the same key',async()=>{
  const http=vi.fn<typeof fetch>(async()=>new Response(null,{status:429}));
  await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'quota'});
  expect(http).toHaveBeenCalledOnce();expect((await db.query('SELECT * FROM llm_cooldowns')).rowCount).toBe(0);
  await expect(new Gemini(db,config,'other',{used:0},http).generate(input)).rejects.toMatchObject({kind:'quota'});expect(http).toHaveBeenCalledOnce();
});
it('provider blocking ends immediately without another call',async()=>{
  const http=vi.fn<typeof fetch>(async()=>Response.json({promptFeedback:{blockReason:'SAFETY'}}));
  await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'blocked'});expect(http).toHaveBeenCalledOnce();
});
it('network failures and malformed payloads are honest failures without uncontrolled retries',async()=>{
  const network=vi.fn<typeof fetch>(async()=>{throw new Error('private-debug-details');});
  await expect(new Gemini(db,config,'actor',{used:0},network).generate(input)).rejects.toMatchObject({kind:'provider'});expect(network).toHaveBeenCalledOnce();
  const malformed=vi.fn<typeof fetch>(async()=>Response.json({candidates:'invalid'}));
  await expect(new Gemini(db,{...config},'actor',{used:0},malformed).generate(input)).rejects.toMatchObject({kind:'invalid'});
});
it('disabled config and exhausted per-message budget never cross the network boundary',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  await expect(new Gemini(db,{...config,GEMINI_FREE_TIER_CONFIRMED:false},'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'disabled'});
  await expect(new Gemini(db,config,'actor',{used:3},http).generate(input)).rejects.toMatchObject({kind:'local_limit',reason:'message'});expect(http).not.toHaveBeenCalled();
});
it('daily quota resets by Pacific day and counts failed attempts too',async()=>{
  await db.query("INSERT INTO llm_usage(actor_id,model,purpose,at,status) SELECT 'other',$1,'test',date_trunc('day',clock_timestamp() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles','http_429' FROM generate_series(1,20)",[config.GEMINI_MODEL]);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',undefined,{...defaultQuotaLimits,dailyLimit:20})).rejects.toMatchObject({kind:'local_limit',reason:'daily'});
  await db.query("UPDATE llm_usage SET at=at-interval '1 day'");await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test')).resolves.toBeTypeOf('string');
});
it('free legacy grounding requires actual sources and never uses Gemini 3 paid grounding',async()=>{
  const http=vi.fn<typeof fetch>(async()=>Response.json({candidates:[{content:{parts:[{text:'Datos'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.com'}}]}}]}));
  expect(await new Gemini(db,config,'actor',{used:0},http).search('actualidad')).toContain('https://example.com');
  expect(String(http.mock.calls[0]?.[0])).toContain('gemini-2.5-flash-lite');
  const noSources=vi.fn<typeof fetch>(async()=>success());await expect(new Gemini(db,config,'actor',{used:0},noSources).search('actualidad')).rejects.toMatchObject({kind:'provider'});
});
it('SearXNG returns source URLs and fails clearly when upstream is unavailable',async()=>{
  const http=vi.fn<typeof fetch>(async()=>Response.json({results:[{title:'Título',url:'https://example.com',content:'Datos'}]}));
  expect(await searxSearch(config,'noticias',http)).toContain('https://example.com');
  expect(String(http.mock.calls[0]?.[0])).toContain('/search?q=noticias&format=json');
  await expect(searxSearch(config,'x',async()=>new Response(null,{status:503}))).rejects.toThrow('unavailable');
});
it('vision fetches only the current authenticated provider message and rejects arbitrary URLs',async()=>{
  const msg:Msg={id:'image1',senderId:'100@s.whatsapp.net',chatId:'300@g.us',isGroup:true,ts:new Date(),text:'bot qué ves',mentions:[],fromMe:false,attachments:[{kind:'image',ref:'image1:image'}]};
  const http=vi.fn<typeof fetch>(async()=>Response.json({mimetype:'image/png',base64:Buffer.from('fixture').toString('base64')}));
  expect((await currentImage(config,msg,http)).mimeType).toBe('image/png');
  const body=JSON.parse(String(http.mock.calls[0]?.[1]?.body)) as {message:{key:{id:string;remoteJid:string}}};expect(body.message.key).toMatchObject({id:'image1',remoteJid:'300@g.us'});
  await expect(currentImage(config,{...msg,attachments:[{kind:'image',ref:'https://attacker.invalid'}]},http)).rejects.toThrow('No current image');expect(http).toHaveBeenCalledOnce();
});

it('uses actual confirmed input tokens so two small calls do not exhaust the next request',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  for(let i=0;i<3;i++)expect((await new Gemini(db,config,'actor',{used:0},http).generate(input)).text).toContain('Hola');
  expect(http).toHaveBeenCalledTimes(3);
  const usage=await db.query<{reserved_input_tokens:number}>('SELECT reserved_input_tokens FROM llm_usage');
  expect(usage.rows.every(r=>r.reserved_input_tokens<product.llmReservedInputTokens)).toBe(true);
});
it('reserves in-flight and failed requests, while the global RPM cap still applies to small requests',async()=>{
  const limits={...defaultQuotaLimits,inputTokensPerMinute:65_536,globalRpm:5};
  const reserve=(tokens:number)=>reserveCall(db,'actor',config.GEMINI_MODEL,'test',tokens,limits);
  const pending=await reserve(65_000);
  await expect(reserve(1_000)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});
  await db.query("UPDATE llm_usage SET status='network_error' WHERE id=$1",[pending]);
  await expect(reserve(1_000)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});
  await db.query("UPDATE llm_usage SET status='ok',input_tokens=10 WHERE id=$1",[pending]);
  for(let i=1;i<limits.globalRpm;i++)await reserve(10);
  await expect(reserve(10)).rejects.toMatchObject({kind:'local_limit',reason:'global'});
});
it('counts text as UTF-8 with a safety margin and image allowance, not as base64 text',()=>{
  const a={...input,contents:[{role:'user',parts:[{text:'foto'},{inlineData:{mimeType:'image/png',data:'a'.repeat(100)}}]}]};
  const b={...input,contents:[{role:'user',parts:[{text:'foto'},{inlineData:{mimeType:'image/png',data:'b'.repeat(100_000)}}]}]};
  expect(estimateInputTokens(a)).toBe(estimateInputTokens(b));
  expect(estimateInputTokens(a)).toBeGreaterThan(estimateInputTokens(input)+product.llmImageReservedTokens-100);
});
it('classifies provider timeouts without retrying and records the cause',async()=>{
  const http=vi.fn<typeof fetch>(async()=>{throw new DOMException('Sensitive details omitted','TimeoutError');});
  await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'timeout'});
  expect(http).toHaveBeenCalledOnce();expect((await db.query('SELECT status FROM llm_usage')).rows[0]?.status).toBe('timeout');
});
it('uses the vision deadline for images and records a response-body timeout too',async()=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');
  const http=vi.fn<typeof fetch>(async()=>success());
  const imageInput={...input,contents:[{role:'user',parts:[{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]}]};
  try{await new Gemini(db,config,'actor',{used:0},http).generate(imageInput);expect(timeout).toHaveBeenLastCalledWith(product.llmVisionTimeoutMs);}
  finally{timeout.mockRestore();}
  const bodyTimeout=vi.fn<typeof fetch>(async()=>{const response=success();vi.spyOn(response,'json').mockRejectedValue(new DOMException('timeout','TimeoutError'));return response;});
  await expect(new Gemini(db,config,'actor',{used:0},bodyTimeout).generate(input)).rejects.toMatchObject({kind:'timeout'});
});

it('preserves exact Gemini call IDs, original ordered parts and opaque signatures through a prepared loop',async()=>{
  const {geminiFunctionResult}=await import('../src/core/provider-tool-context.js');
  const content={role:'model',providerExtension:'keep',parts:[
    {text:'internal',thought:true,thoughtSignature:'opaque-thought'},
    {functionCall:{id:'Provider-ID/Exact==',name:'notes_search',args:{query:'x'},extra:'keep'},thoughtSignature:'opaque-call',partMetadata:{key:'keep'}},
    {functionCall:{id:'second-ID',name:'notes_search',args:{query:'y'}}},
    {toolCall:{id:'server-tool',name:'opaque'},thoughtSignature:'server-signature'},
  ]};
  const http=vi.fn<typeof fetch>(async()=>Response.json({candidates:[{content}],usageMetadata:{promptTokenCount:5}}));
  const llm=new Gemini(db,config,'actor',{used:0},http);
  const reply=await llm.generate(input);
  expect(reply.text).toBe('');
  expect(reply.content).toEqual(content);
  expect(reply.calls[0]?.id).toBe('Provider-ID/Exact==');
  expect(reply.providerContext?.modelContent).toBe(reply.content);
  expect(reply.providerContext?.calls.map(c=>c.partIndex)).toEqual([1,2]);
  const parts=reply.calls.map(call=>geminiFunctionResult(call,{status:'ok'}));
  expect(parts[0]?.functionResponse.id).toBe('Provider-ID/Exact==');
  await llm.generate({...input,contents:[...input.contents,reply.providerContext!.modelContent,{role:'user',parts}]});
  const sent=JSON.parse(String(http.mock.calls[1]?.[1]?.body)) as {contents:unknown[]};
  expect(sent.contents[1]).toEqual(content);
  expect(sent.contents[2]).toEqual({role:'user',parts});
  expect(geminiFunctionResult({name:'legacy',args:{}},{status:'ok'}).functionResponse).not.toHaveProperty('id');
});
it('applies environment quota reductions before making provider requests',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  const llm=new Gemini(db,{...config,LLM_LOCAL_GLOBAL_RPM:1},'actor',{used:0},http);
  await llm.generate(input);
  await expect(llm.generate(input)).rejects.toMatchObject({kind:'local_limit',reason:'global'});
  expect(http).toHaveBeenCalledOnce();
});

it('disables only adjustable provider filters and records blocked responses with their actual usage',async()=>{
  const http=vi.fn<typeof fetch>(async()=>Response.json({candidates:[{finishReason:'SPII'}],usageMetadata:{promptTokenCount:18,candidatesTokenCount:2}}));
  const llm=new Gemini(db,config,'actor',{used:0},http);
  await expect(llm.generate(input)).rejects.toMatchObject({kind:'blocked'});
  const body=JSON.parse(String(http.mock.calls[0]?.[1]?.body)) as {safetySettings:{category:string;threshold:string}[]};
  expect(body.safetySettings).toHaveLength(4);
  expect(body.safetySettings).toContainEqual({category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'OFF'});
  expect(body.safetySettings.every(s=>s.threshold==='OFF')).toBe(true);
  expect((await db.query('SELECT status,input_tokens,output_tokens FROM llm_usage')).rows[0]).toEqual({status:'provider_blocked_spii',input_tokens:18,output_tokens:2});
  expect(llm.counters).toEqual({calls:1,inputTokens:18,outputTokens:2});
  expect(http).toHaveBeenCalledOnce();
});

it('uses native function-calling ANY only for a requested correction with tools',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  const llm=new Gemini(db,config,'actor',{used:0},http);
  await llm.generate({...input,requireFunctionCall:true,tools:[{name:'media_process',description:'Crear QR',parametersJsonSchema:{type:'object',properties:{},additionalProperties:false}}]});
  expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body)).toolConfig).toEqual({functionCallingConfig:{mode:'ANY'}});
});

it.each([1,2,3])('uses %i limited keys at most once and accounts for each provider attempt',async limited=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two','fixture-three']};
  let attempts=0;
  const http=vi.fn<typeof fetch>(async()=>++attempts<=limited?new Response(null,{status:429,headers:{'retry-after':'120'}}):success());
  const budget={used:0};const llm=new Gemini(db,pooled,'actor',budget,http);
  if(limited===3)await expect(llm.generate(input)).rejects.toMatchObject({kind:'quota'});
  else expect((await llm.generate(input)).text).toContain('Hola');
  expect(http).toHaveBeenCalledTimes(Math.min(limited+1,3));expect(budget.used).toBe(1);
  expect(new Set(http.mock.calls.map(([,init])=>new Headers(init?.headers).get('x-goog-api-key'))).size).toBe(http.mock.calls.length);
  expect((await db.query('SELECT count(*)::int n FROM llm_usage')).rows[0]?.n).toBe(http.mock.calls.length);
  expect(llm.counters.calls).toBe(http.mock.calls.length);
});
it.each([401,403,400])('disables unauthorized HTTP %i keys across adapter instances',async status=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two']};
  const http=vi.fn<typeof fetch>(async(_url,init)=>new Headers(init?.headers).get('x-goog-api-key')==='fixture-one'
    ?Response.json({error:{details:[{reason:'API_KEY_INVALID'}],message:'Never log this fixture-one'}},{status}):success());
  for(let n=0;n<3;n++)expect((await new Gemini(db,pooled,'actor',{used:0},http).generate(input)).text).toContain('Hola');
  expect(http.mock.calls.filter(([,init])=>new Headers(init?.headers).get('x-goog-api-key')==='fixture-one')).toHaveLength(1);
});
it.each(['network','timeout','body_timeout','5xx'])('retries only Gemini on %s with an identical request body',async kind=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two']};let calls=0;
  const http=vi.fn<typeof fetch>(async()=>{
    if(++calls===1){
      if(kind==='network')throw new Error('fixture-one private-debug');
      if(kind==='timeout')throw new DOMException('fixture-one private-debug','TimeoutError');
      if(kind==='5xx')return new Response(null,{status:503,headers:{'retry-after':'180'}});
      const response=success();vi.spyOn(response,'json').mockRejectedValue(new DOMException('fixture-one private-debug','TimeoutError'));return response;
    }
    return success();
  });
  expect((await new Gemini(db,pooled,'actor',{used:0},http).generate(input)).text).toContain('Hola');
  expect(http).toHaveBeenCalledTimes(2);expect(http.mock.calls[0]?.[1]?.body).toBe(http.mock.calls[1]?.[1]?.body);
});
it('shares concurrency protection across actors and adapter instances and accounts for queued calls',async()=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two'],LLM_MAX_CONCURRENT_CALLS:2};
  const releases:(()=>void)[]=[];let active=0,maxActive=0;
  const http=vi.fn<typeof fetch>(async()=>{
    active++;maxActive=Math.max(active,maxActive);await new Promise<void>(resolve=>releases.push(resolve));active--;return success();
  });
  const pending=Array.from({length:7},(_,n)=>new Gemini(db,pooled,`actor-${n}`,{used:0},http).generate(input));
  await vi.waitFor(()=>expect(releases).toHaveLength(2));
  for(let n=0;n<7;n++){releases[n]!();if(n<5)await vi.waitFor(()=>expect(releases).toHaveLength(n+3));}
  expect(await Promise.all(pending)).toHaveLength(7);expect(maxActive).toBe(2);expect(http).toHaveBeenCalledTimes(7);
});
it('does not impose the old 20/day, 5 global RPM or local TPM defaults',async()=>{
  await db.query("INSERT INTO llm_usage(actor_id,model,purpose,reserved_input_tokens) SELECT 'actor',$1,'test',100000 FROM generate_series(1,25)",[config.GEMINI_MODEL]);
  // Historical model-wide cooldown must not suppress healthy keys in the new pool.
  await db.query("INSERT INTO llm_cooldowns(model,until_at) VALUES($1,now()+interval '1 hour')",[config.GEMINI_MODEL]);
  const http=vi.fn<typeof fetch>(async()=>success());
  expect((await new Gemini(db,config,'actor',{used:0},http).generate(input)).text).toContain('Hola');
  expect(http).toHaveBeenCalledOnce();
});
it.each(['userRpm','globalRpm','dailyLimit'])('enforces configured positive %s atomically and lets zero disable it',async field=>{
  const limits={...defaultQuotaLimits,[field]:1};
  await reserveCall(db,'actor',config.GEMINI_MODEL,'test',10,limits);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',10,limits)).rejects.toMatchObject({kind:'local_limit'});
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',10,{...limits,[field]:0})).resolves.toBeTypeOf('string');
});
it.each(['vision','grounding'])('uses the same pool and payload for %s failover',async kind=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two']};let attempts=0;
  const http=vi.fn<typeof fetch>(async()=>++attempts===1?new Response(null,{status:429}):Response.json({candidates:[{content:{role:'model',parts:[{text:'Respuesta con fuente.'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.com'}}]}}]}));
  const llm=new Gemini(db,pooled,'actor',{used:0},http);
  if(kind==='vision')await llm.generate({...input,contents:[{role:'user',parts:[{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]}]});
  else expect(await llm.search('consulta')).toContain('https://example.com');
  expect(http).toHaveBeenCalledTimes(2);expect(http.mock.calls[0]?.[1]?.body).toBe(http.mock.calls[1]?.[1]?.body);
  expect((await db.query('SELECT purpose FROM llm_usage ORDER BY at')).rows).toEqual([{purpose:kind==='vision'?'vision':'web'},{purpose:kind==='vision'?'vision':'web'}]);
});

it('v1.1 validates native calls against the current schema names while legacy keeps AUTO and retries keep ANY',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  const tools=[{name:'core_load_capability',description:'Load domain',parametersJsonSchema:{type:'object',properties:{domain:{type:'string'}},required:['domain']}}];
  const body=()=>JSON.parse(String(http.mock.lastCall?.[1]?.body)) as {toolConfig?:{functionCallingConfig:{mode:string;allowedFunctionNames?:string[]}}};
  await new Gemini(db,config,'actor',{used:0},http).generate({...input,tools});
  expect(body().toolConfig).toBeUndefined();
  await new Gemini(db,config,'actor',{used:0},http).generate({...input,tools,validateFunctionCalls:true});
  expect(body().toolConfig?.functionCallingConfig).toEqual({mode:'VALIDATED',allowedFunctionNames:['core_load_capability']});
  await new Gemini(db,config,'actor',{used:0},http).generate({...input,tools,validateFunctionCalls:true,requireFunctionCall:true});
  expect(body().toolConfig?.functionCallingConfig.mode).toBe('ANY');
});
