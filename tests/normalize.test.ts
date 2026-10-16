import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
import { normalizeData,normalizeEvent,normalizeMessage } from '../src/wa/normalize.js';
import { activated } from '../src/core/activation.js';
const fixture=(name:string):unknown=>JSON.parse(readFileSync(`tests/fixtures/${name}.json`,'utf8'));
const history=fixture('history') as {messages:{records:{messageType:string;message:{conversation?:string}}[]}};
describe('actual Evolution 2.3.7 captures',()=>{
  it('normalizes the original group webhook that produced the confirmed pong',()=>{
    const msg=normalizeMessage(fixture('text-group'),'botsky');
    expect(msg?.text).toBe('bot ping');expect(msg?.chatId).toBe('300@g.us');expect(msg?.senderId).toBe('111@lid');
  });
  it('normalizes the original private webhook with its provider timestamp',()=>{
    const msg=normalizeMessage(fixture('text-private'),'botsky');
    expect(msg?.senderId).toBe('100@s.whatsapp.net');expect(msg?.isGroup).toBe(false);expect(msg?.text).toBe('bot ping privado');
    expect(msg?.ts.getTime()).toBe(1792111174000);
  });
  it.each([['audioMessage','audio'],['imageMessage','image'],['documentMessage','document']])('keeps %s as references without bytes', (file,kind)=>{
    const msg=normalizeMessage(fixture(file),'botsky');expect(msg?.attachments[0]?.kind).toBe(kind);
    expect(msg?.senderId).toBe('111@lid');expect(msg?.text).toBe('');
    expect(JSON.stringify(msg)).not.toMatch(/mediaKey|directPath|base64|sha256/);
  });
  it('normalizes a reaction without triggering the message pipeline',()=>{
    const event=normalizeEvent(fixture('reactionMessage'),'botsky');
    expect(event).toMatchObject({kind:'reaction',chatId:'300@g.us',actorId:'111@lid',emoji:'👍',msgId:'msg-a401473a6063'});
    expect(normalizeMessage(fixture('reactionMessage'),'botsky')).toBeNull();
  });
  it('normalizes real group text and retains unresolved actor identity',()=>{
    const record=history.messages.records.find(r=>r.message.conversation==='bot ping');
    const event=normalizeData(record);expect(event?.kind).toBe('message');
    if(event?.kind!=='message')throw new Error('Missing group fixture');
    expect(event.message.senderId).toBe('111@lid');expect(event.message.chatId).toBe('300@g.us');
  });
  it('separates real quoted text from the current user text',()=>{
    const record=history.messages.records.find(r=>r.message.conversation==='prueba de cita');
    const event=normalizeData(record);if(event?.kind!=='message')throw new Error('Missing quote fixture');
    expect(event.message.text).toBe('prueba de cita');expect(event.message.quoted?.text).toBe('bot ping');
    expect(event.message.quoted?.fromBot).toBe(false);expect(activated(event.message,['222@lid'])).toBe(false);
  });
  it('preserves the actual LID mention supplied separately by Evolution',()=>{
    const record=history.messages.records.find(r=>r.message.conversation==='@222 ping');
    const event=normalizeData(record);if(event?.kind!=='message')throw new Error('Missing mention fixture');
    expect(event.message.mentions).toEqual(['222@lid']);expect(activated(event.message,['222@lid'])).toBe(true);
  });
  it('ignores a different instance and own messages; malformed events fail validation',()=>{
    expect(normalizeEvent(fixture('text-private'),'other')).toBeNull();
    const raw=fixture('text-private') as {data:{key:{fromMe:boolean}}};raw.data.key.fromMe=true;
    expect(normalizeEvent(raw,'botsky')).toBeNull();
    expect(()=>normalizeEvent({event:'messages.upsert',instance:'botsky',data:{}},'botsky')).toThrow();
  });
});
it('retains an original manual-test image quote as a scoped reference without media credentials',()=>{
  const event=normalizeData(fixture('image-quote'));if(event?.kind!=='message')throw new Error('Missing captured image quote');
  expect(event.message.text).toBe('oye botsky de que color es lo que sale aqui?');
  expect(event.message.attachments).toEqual([]);
  expect(event.message.quoted?.attachments).toEqual([{kind:'image',ref:'manual-image-origin:image',mime:'image/jpeg'}]);
  expect(JSON.stringify(event.message)).not.toMatch(/mediaKey|directPath|base64|sha256|https?:/);
});
