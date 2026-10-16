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
it('refuses real groups outside the laboratory and unresolved LID destinations',async()=>{
  expect((await adapter.send({...delivery,chatId:'999@g.us'})).status).toBe('failed');
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
