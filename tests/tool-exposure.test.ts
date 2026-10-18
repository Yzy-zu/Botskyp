import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createRegistry } from '../src/core/registry.js';
import { alwaysOnBusinessTools, createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { selectToolExposure, ToolExposureTurn, type ToolExposureInput } from '../src/core/tool-exposure.js';
import { capabilityDomains } from '../src/core/capability-domain.js';
const catalog=createToolRegistryV2(createRegistry());
const modules=[...new Set(catalog.map(t=>t.requiredModule))];
const input=(extra:Partial<ToolExposureInput>={}):ToolExposureInput=>({actorRole:'owner',chatType:'group',enabledModules:modules,...extra});
it('uses only always-on and meta schemas without structured activity',()=>{
  expect(selectToolExposure(catalog,input()).toolNames).toEqual([...alwaysOnBusinessTools,'core.load_capability','core.load_artifact_context']);
});
it('is invariant under arbitrary current and quoted human language',()=>{
  const expected=selectToolExposure(catalog,input());
  for(let i=0;i<20;i++)expect(selectToolExposure(catalog,input({text:randomBytes(40).toString('base64url'),quotedText:randomBytes(40).toString('base64url')}))).toEqual(expected);
});
it.each([
  [{activeSession:{domain:'school' as const}},'school.schedule'],
  [{currentAttachment:{kind:'document'}},'media.process'],
  [{activeGame:true},'games.play'],
  [{openPoll:true},'polls.vote'],
  [{openCooperacha:true},'cooperacha.status'],
] as const)('loads structured state %j', (state,name)=>expect(selectToolExposure(catalog,input(state)).toolNames).toContain(name));
it('old artifacts and old quotes never preload a domain',()=>{
  expect(selectToolExposure(catalog,input({recentArtifactContext:[{kind:'image'}],quotedText:'minecraft'})).toolNames).toEqual(selectToolExposure(catalog,input()).toolNames);
});
it('keeps session meta-tools scoped to active structured state',()=>{
  const confirm=selectToolExposure(catalog,input({activeSession:{domain:'messaging',kind:'confirm',pendingTool:'bulk.nuclear'}}));
  expect(confirm.toolNames).toContain('core.session_confirm');expect(confirm.toolNames).toContain('core.session_cancel');
  const clarify=selectToolExposure(catalog,input({activeSession:{domain:'productivity',kind:'clarify'}}));
  expect(clarify.toolNames).not.toContain('core.session_confirm');expect(clarify.toolNames).toContain('core.session_cancel');
});
it('never exceeds 20 schemas or exposes internal tools under structured contention',()=>{
  for(const role of ['owner','group_admin','member'] as const)for(const chatType of ['group','private'] as const)for(const domain of capabilityDomains){
    const result=selectToolExposure(catalog,input({actorRole:role,chatType,activeSession:{domain},activeGame:true,openPoll:true,openCooperacha:true,currentAttachment:{kind:'image'}}));
    expect(result.schemas.length).toBeLessThanOrEqual(20);expect(new Set(result.toolNames).size).toBe(result.schemas.length);
    expect(result.toolNames).not.toContain('bulk.confirm');expect(result.toolNames).not.toContain('school.schedule_commit');
    for(const name of result.toolNames)expect(catalog.find(t=>t.name===name)?.scope).not.toBe(chatType==='private'?'group':'private');
  }
});
it('filters disabled modules and owner-only administration without losing discovery',()=>{
  for(const module of modules){
    const turn=new ToolExposureTurn(catalog,input({enabledModules:modules.filter(m=>m!==module),activeSession:{domain:'school'},currentAttachment:{kind:'image'}}));
    for(const name of turn.exposure.toolNames)expect(catalog.find(t=>t.name===name)?.requiredModule).not.toBe(module);
  }
  expect(new ToolExposureTurn(catalog,input({actorRole:'member'})).loadCapability({domain:'admin'}).status).toBe('not_relevant_or_allowed');
});
it('validates one domain expansion, rotates unrelated schemas and fits actual envelope budget',()=>{
  const turn=new ToolExposureTurn(catalog,input({activeGame:true,openPoll:true,currentAttachment:{kind:'image'}}));
  expect(turn.loadCapability({domain:'unknown'}).status).toBe('invalid_domain');
  expect(turn.loadCapability({domain:'drive',actorId:'forged'}).status).toBe('invalid_domain');
  expect(turn.loadCapability({domain:'minecraft'}).status).toBe('ok');expect(turn.exposure.toolNames).toContain('minecraft.restart');
  expect(turn.exposure.schemas.length).toBeLessThanOrEqual(20);expect(turn.loadCapability({domain:'games'}).status).toBe('expansion_limit');
  turn.fitSchemaBudget(4000);expect(JSON.stringify(turn.exposure.schemas).length).toBeLessThanOrEqual(4000);
  expect(turn.exposure.toolNames).toContain('core.load_capability');expect(turn.exposure.toolNames).toContain('core.load_artifact_context');
});
