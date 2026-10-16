import { readFileSync } from 'node:fs';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { Gemini,estimateInputTokens } from '../src/core/llm.js';
import { reserveCall } from '../src/core/quota.js';
import { product } from '../config/product.js';
import { searxSearch } from '../src/modules/web/index.js';
import { currentImage } from '../src/wa/media.js';
import type { Msg } from '../src/wa/types.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
const db=createDb(url);
const config=readConfig({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock',GEMINI_API_KEY:'test-key-never-log',GEMINI_FREE_TIER_CONFIRMED:'true'});
const input={system:'Sistema',contents:[{role:'user',parts:[{text:'hola'}]}],tools:[]};
const success=()=>Response.json({candidates:[{content:{role:'model',parts:[{text:'Hola, perrillo.'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:5}});
beforeAll(()=>migrate(db));afterAll(()=>db.end());beforeEach(()=>db.query('TRUNCATE llm_usage,llm_cooldowns').then(()=>undefined));
it('uses a fixed Google endpoint, header auth, typed payload and persistent accounting',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());const llm=new Gemini(db,config,'actor',{used:0},http);
  expect((await llm.generate(input)).text).toBe('Hola, perrillo.');
  const [endpoint,init]=http.mock.calls[0]!;expect(endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  expect(String(endpoint)).not.toContain(config.GEMINI_API_KEY);expect(init?.headers).toHaveProperty('x-goog-api-key',config.GEMINI_API_KEY);
  const usage=(await db.query('SELECT status,input_tokens,output_tokens FROM llm_usage')).rows[0];expect(usage).toEqual({status:'ok',input_tokens:12,output_tokens:5});
});
it('quota reservations are atomic and persist across adapter instances',async()=>{
  const results=await Promise.allSettled(Array.from({length:5},()=>reserveCall(db,'actor',config.GEMINI_MODEL,'test')));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  const http=vi.fn<typeof fetch>(async()=>success());await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});expect(http).not.toHaveBeenCalled();
});
it('429 retries once with bounded backoff, then opens a persisted cooldown',async()=>{
  const http=vi.fn<typeof fetch>(async()=>new Response(null,{status:429}));
  await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'quota'});
  expect(http).toHaveBeenCalledTimes(2);expect((await db.query('SELECT * FROM llm_cooldowns')).rowCount).toBe(1);
});
it('provider blocking ends immediately without another call',async()=>{
  const http=vi.fn<typeof fetch>(async()=>Response.json({promptFeedback:{blockReason:'SAFETY'}}));
  await expect(new Gemini(db,config,'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'blocked'});expect(http).toHaveBeenCalledOnce();
});
it('network failures and malformed payloads are honest failures without uncontrolled retries',async()=>{
  const network=vi.fn<typeof fetch>(async()=>{throw new Error('private-debug-details');});
  await expect(new Gemini(db,config,'actor',{used:0},network).generate(input)).rejects.toMatchObject({kind:'provider'});expect(network).toHaveBeenCalledOnce();
  const malformed=vi.fn<typeof fetch>(async()=>Response.json({candidates:'invalid'}));
  await expect(new Gemini(db,config,'actor',{used:0},malformed).generate(input)).rejects.toMatchObject({kind:'invalid'});
});
it('disabled config and exhausted per-message budget never cross the network boundary',async()=>{
  const http=vi.fn<typeof fetch>(async()=>success());
  await expect(new Gemini(db,{...config,GEMINI_FREE_TIER_CONFIRMED:false},'actor',{used:0},http).generate(input)).rejects.toMatchObject({kind:'disabled'});
  await expect(new Gemini(db,config,'actor',{used:3},http).generate(input)).rejects.toMatchObject({kind:'local_limit',reason:'message'});expect(http).not.toHaveBeenCalled();
});
it('daily quota resets by Pacific day and counts failed attempts too',async()=>{
  await db.query("INSERT INTO llm_usage(actor_id,model,purpose,at,status) SELECT 'other',$1,'test',date_trunc('day',clock_timestamp() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles','http_429' FROM generate_series(1,20)",[config.GEMINI_MODEL]);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test')).rejects.toMatchObject({kind:'local_limit',reason:'daily'});
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
  const pending=await reserveCall(db,'actor',config.GEMINI_MODEL,'test',65_000);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',1_000)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});
  await db.query("UPDATE llm_usage SET status='network_error' WHERE id=$1",[pending]);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',1_000)).rejects.toMatchObject({kind:'local_limit',reason:'tokens'});
  await db.query("UPDATE llm_usage SET status='ok',input_tokens=10 WHERE id=$1",[pending]);
  for(let i=1;i<product.llmGlobalRpm;i++)await reserveCall(db,'actor',config.GEMINI_MODEL,'test',10);
  await expect(reserveCall(db,'actor',config.GEMINI_MODEL,'test',10)).rejects.toMatchObject({kind:'local_limit',reason:'global'});
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
