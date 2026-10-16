import { beforeEach,expect,it,vi } from 'vitest';
import { EvolutionGroups } from '../src/wa/group-control.js';
import { readConfig } from '../src/config.js';
const config=readConfig({DATABASE_URL:'postgresql://test:test@localhost/test',EVOLUTION_URL:'http://provider',EVOLUTION_APIKEY:'test-key',INSTANCE:'botsky',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'});
const adapter=new EvolutionGroups(config);
beforeEach(()=>vi.restoreAllMocks());
it('uses authenticated GET roster with exact group scope',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementationOnce(async(url,init)=>{
    expect(String(url)).toBe('http://provider/group/findGroupInfos/botsky?groupJid=300%40g.us');expect(init?.headers).toMatchObject({apikey:'test-key'});expect(init?.method).toBe('GET');
    return Response.json({id:'300@g.us',participants:[{id:'600@lid',phoneNumber:'600@s.whatsapp.net',admin:null}]});
  });expect((await adapter.roster('300@g.us')).participants).toHaveLength(1);
});
it('rejects malformed or mismatched roster and conflicting alias evidence',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');fetch.mockResolvedValueOnce(Response.json({id:'400@g.us',participants:[]}));await expect(adapter.roster('300@g.us')).rejects.toThrow();
  fetch.mockResolvedValueOnce(Response.json({id:'300@g.us',participants:[{id:'600@s.whatsapp.net',phoneNumber:'700@s.whatsapp.net'}]}));await expect(adapter.roster('300@g.us')).rejects.toThrow();
});
it('sends a single remove target and validates the participant result, not just HTTP 201',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementationOnce(async(url,init)=>{
    expect(String(url)).toBe('http://provider/group/updateParticipant/botsky');expect(JSON.parse(String(init?.body))).toEqual({groupJid:'300@g.us',action:'remove',participants:['600@s.whatsapp.net']});
    return Response.json({updateParticipants:[{jid:'600@s.whatsapp.net',status:'200'}]},{status:201});
  });expect(await adapter.remove('300@g.us','600@s.whatsapp.net')).toBe('accepted');
});
it.each([[429,'retry'],[401,'rejected'],[500,'unknown'],[408,'unknown']])('HTTP %i maps to %s',async(status,result)=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:Number(status)}));expect(await adapter.remove('300@g.us','600@s.whatsapp.net')).toBe(result);
});
it('ambiguous network failures and success-shaped responses never mean confirmed kick',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');fetch.mockRejectedValueOnce(new Error('network'));expect(await adapter.remove('300@g.us','600@s.whatsapp.net')).toBe('unknown');
  fetch.mockResolvedValueOnce(Response.json({success:true}));expect(await adapter.remove('300@g.us','600@s.whatsapp.net')).toBe('unknown');
});
it('only accepts a consistent WhatsApp invite URL and code from the installed API',async()=>{
  const code='A'.repeat(22);const fetch=vi.spyOn(globalThis,'fetch');fetch.mockImplementationOnce(async(url)=>{expect(String(url)).toContain('/group/inviteCode/botsky?groupJid=300%40g.us');return Response.json({inviteUrl:`https://chat.whatsapp.com/${code}`,inviteCode:code});});
  expect(await adapter.invite('300@g.us')).toBe(`https://chat.whatsapp.com/${code}`);
  fetch.mockResolvedValueOnce(Response.json({inviteUrl:'https://evil.example/',inviteCode:code}));await expect(adapter.invite('300@g.us')).rejects.toThrow();
});
it('all group operations reject destinations outside Lab before network',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');await expect(adapter.roster('400@g.us')).rejects.toThrow();await expect(adapter.remove('400@g.us','600@s.whatsapp.net')).rejects.toThrow();await expect(adapter.invite('400@g.us')).rejects.toThrow();
  expect(await adapter.remove('300@g.us','600@lid')).toBe('rejected');expect(fetch).not.toHaveBeenCalled();
});
it('duplicate canonical identities cannot hide a group administrator',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({id:'300@g.us',participants:[{id:'600@lid',phoneNumber:'600@s.whatsapp.net',admin:null},{id:'700@lid',phoneNumber:'600@s.whatsapp.net',admin:'admin'}]}));
  await expect(adapter.roster('300@g.us')).rejects.toThrow();
});
