import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { beforeAll,afterAll,beforeEach,it,expect,vi } from 'vitest';
import { Evolution } from '../src/wa/evolution.js';
import { readConfig } from '../src/config.js';
const provider=Fastify({logger:false});
let mode=200;let sends=0;let rows:unknown[]=[];let received:unknown;
provider.get('/instance/connectionState/botsky',()=>({instance:{instanceName:'botsky',state:'open'}}));
provider.get('/group/findGroupInfos/botsky',()=>JSON.parse(readFileSync('tests/fixtures/participants.json','utf8')) as unknown);
provider.post('/message/sendText/botsky',async(req,reply)=>{
  sends++;received=req.body;expect(req.headers.apikey).toBe('test-api-key');
  if(mode!==200)return reply.code(mode).send({error:'test_failure'});
  return {key:{id:'provider-1',remoteJid:'300@g.us',fromMe:true}};
});
provider.post('/chat/findMessages/botsky',()=>({messages:{total:rows.length,pages:1,currentPage:1,records:rows}}));
let adapter:Evolution;
const delivery={id:'1',chatId:'300@g.us',text:'pong',sourceId:'inbound-1'};
beforeAll(async()=>{
  const url=await provider.listen({host:'127.0.0.1',port:0});
  adapter=new Evolution(readConfig({DATABASE_URL:'postgresql://test:test@localhost/test',EVOLUTION_URL:url,EVOLUTION_APIKEY:'test-api-key',INSTANCE:'botsky',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'}));
});
afterAll(()=>provider.close());
beforeEach(()=>{mode=200;sends=0;received=undefined;rows=[];vi.restoreAllMocks();});
it('uses authenticated REST state and actual participant fixture',async()=>{
  expect(await adapter.state()).toBe(true);expect(await adapter.participants()).toMatchObject({id:'300@g.us'});
});
it('sends an exact quoted reply through the documented REST contract',async()=>{
  expect(await adapter.send(delivery)).toEqual({status:'sent',id:'provider-1'});
  expect(received).toEqual({number:'300@g.us',text:'pong',linkPreview:false,quoted:{key:{id:'inbound-1',remoteJid:'300@g.us'}}});
});
it.each([[401,'failed'],[429,'retry'],[500,'uncertain'],[408,'uncertain']])('classifies HTTP %i without invented success',async(code,status)=>{
  mode=Number(code);expect((await adapter.send(delivery)).status).toBe(status);
});
it('preserves network ambiguity',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('simulated_connection_loss'));
  expect((await adapter.send(delivery)).status).toBe('uncertain');
});
it('refuses unresolved LID destinations',async()=>{
  expect((await adapter.send({...delivery,chatId:'999@lid'})).status).toBe('failed');expect(sends).toBe(0);
});
it('a real history response without a matching outgoing message does not prove absence',async()=>{
  rows=(JSON.parse(readFileSync('tests/fixtures/history.json','utf8')) as {messages:{records:unknown[]}}).messages.records;
  expect(await adapter.reconcile(delivery)).toEqual({status:'unknown'});
});
it('reconciles only one exact outgoing quote; identical unquoted text is insufficient',async()=>{
  rows=[{key:{id:'unrelated',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'}}];
  expect(await adapter.reconcile(delivery)).toEqual({status:'unknown'});
  rows.push({key:{id:'matching',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'},contextInfo:{stanzaId:'inbound-1'}});
  expect(await adapter.reconcile(delivery)).toEqual({status:'found',id:'matching'});
  expect(await adapter.reconcile(delivery,'unrelated')).toEqual({status:'found',id:'unrelated'});
});

it('reconciles the original pong recorded by the real provider using its quoted request',async()=>{
  const captured=JSON.parse(readFileSync('tests/fixtures/history.json','utf8')) as {messages:{records:{key:{id:string;fromMe:boolean};contextInfo?:{stanzaId?:string};message:{conversation?:string}}[]}};
  rows=captured.messages.records;
  const outgoing=captured.messages.records.find(r=>r.key.fromMe && r.message.conversation==='pong');
  if(!outgoing?.contextInfo?.stanzaId)throw new Error('Original quoted pong missing');
  expect(await adapter.reconcile({...delivery,sourceId:outgoing.contextInfo.stanzaId})).toEqual({status:'found',id:outgoing.key.id});
});
it('sends school originals via the installed media contract without altering the text or bytes',async()=>{
  let body:Record<string,unknown>|undefined;
  vi.spyOn(globalThis,'fetch').mockImplementationOnce(async(url,init)=>{
    expect(String(url)).toContain('/message/sendMedia/botsky');
    body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    return Response.json({key:{id:'media-1',remoteJid:'300@g.us',fromMe:true}},{status:201});
  });
  const media={kind:'document' as const,mime:'application/pdf',base64:Buffer.from('%PDF-original').toString('base64')};
  expect(await adapter.send({...delivery,media})).toEqual({status:'sent',id:'media-1'});
  expect(body).toMatchObject({number:'300@g.us',mediatype:'document',mimetype:'application/pdf',media:media.base64,caption:'pong',fileName:'adjunto-1.pdf',quoted:{key:{id:'inbound-1',remoteJid:'300@g.us'}}});
});
it('an uncertain media send cannot be reconciled by a caption-only text match',async()=>{
  rows=[{key:{id:'text-only',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'},contextInfo:{stanzaId:'inbound-1'}}];
  expect(await adapter.reconcile({...delivery,attachmentId:'f7b4b074-d968-444b-969c-7b31c3c12a96'})).toEqual({status:'unknown'});
});

it('Phase 7 treats HTTP 201 with PENDING as acceptance and retains its provider ID',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({key:{id:'pending-7',remoteJid:'300@g.us',fromMe:true},status:'PENDING'},{status:201}));
  expect(await adapter.send({...delivery,requireReceipt:true})).toEqual({status:'uncertain',reason:'provider_accepted_pending_receipt',id:'pending-7'});
});
it('preserves Retry-After from Evolution without retrying a bulk effect itself',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({error:'rate_limit'},{status:429,headers:{'retry-after':'120'}}));
  expect(await adapter.send({...delivery,requireReceipt:true})).toEqual({status:'retry',reason:'provider_rate_limit',retryAfterMs:120000});
});
it('Phase 7 confirms only a provider acknowledgement and never pending history',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({key:{id:'ack-7',remoteJid:'300@g.us',fromMe:true},status:'SERVER_ACK'},{status:201}));
  expect(await adapter.send({...delivery,requireReceipt:true})).toEqual({status:'sent',id:'ack-7'});
  rows=[{key:{id:'ack-7',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'},MessageUpdate:[{status:'PENDING'}]}];
  expect(await adapter.reconcile({...delivery,requireReceipt:true},'ack-7')).toEqual({status:'unknown'});
  rows=[{key:{id:'ack-7',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'},MessageUpdate:[{status:'SERVER_ACK'}]}];
  expect(await adapter.reconcile({...delivery,requireReceipt:true},'ack-7')).toEqual({status:'found',id:'ack-7'});
});
it('Phase 7 does not confirm identical content in the wrong chat or an unquoted Nuclear send',async()=>{
  rows=[{key:{id:'other-chat',remoteJid:'400@g.us',fromMe:true},message:{conversation:'pong'},MessageUpdate:[{status:'SERVER_ACK'}]}];
  expect(await adapter.reconcile({...delivery,requireReceipt:true},'other-chat')).toEqual({status:'unknown'});
  rows=[{key:{id:'unquoted',remoteJid:'300@g.us',fromMe:true},message:{conversation:'pong'},MessageUpdate:[{status:'SERVER_ACK'}]}];
  expect(await adapter.reconcile({...delivery,requireReceipt:true})).toEqual({status:'unknown'});
});

it.each(['audio','video','sticker'] as const)('sends Phase 5 %s through its verified contract and preserves ambiguous sends',async kind=>{
  const media={kind,mime:kind==='audio'?'audio/ogg':kind==='video'?'video/mp4':'image/webp',base64:'dGVzdA==',fileName:'botsky-1.ogg'};
  vi.spyOn(globalThis,'fetch').mockImplementationOnce(async(url,init)=>{
    expect(String(url)).toContain(kind==='sticker'?'/sendSticker/':'/sendMedia/');
    const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    expect(body[kind==='sticker'?'sticker':'media']).toBe(media.base64);
    if(kind!=='sticker')expect(body['mediatype']).toBe(kind);
    return Response.json({key:{id:'media-5',remoteJid:'300@g.us',fromMe:true}},{status:201});
  });
  expect(await adapter.send({...delivery,media})).toEqual({status:'sent',id:'media-5'});
  vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('lost_response'));
  expect((await adapter.send({...delivery,media})).status).toBe('uncertain');
});
