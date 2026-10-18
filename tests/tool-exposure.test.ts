import { expect, it } from 'vitest';
import { createRegistry } from '../src/core/registry.js';
import { alwaysOnBusinessTools, createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { MAX_TOOLS_PER_TURN, MAX_CAPABILITY_EXPANSIONS_PER_TURN, selectToolExposure, ToolExposureTurn, type ToolExposureInput } from '../src/core/tool-exposure.js';
import { capabilityDomains } from '../src/core/capability-domain.js';
import { exactFastPathV2 } from '../src/core/shortcuts-v2.js';

const catalog = createToolRegistryV2(createRegistry());
const modules = [...new Set(catalog.map(tool => tool.requiredModule))];
const input = (text: string, extra: Partial<ToolExposureInput> = {}): ToolExposureInput => ({ text, actorRole: 'member', chatType: 'group', enabledModules: modules, ...extra });
const select = (text: string, extra: Partial<ToolExposureInput> = {}) => selectToolExposure(catalog, input(text, extra));
it.each(['owner','group_admin','member'] as const)('keeps hello to the definitive base set for %s', actorRole => {
  expect(select('hola botsky', { actorRole }).toolNames).toEqual([...alwaysOnBusinessTools, 'core.load_capability']);
});
it.each([
  ['oye cuánto xp tengo','economy',['xp.balance']],
  ['jalo blackjack de 20','games',['games.blackjack','games.play']],
  ['hay alguien jugando minecraft','minecraft',['minecraft.status','minecraft.players']],
  ['reinicia minecraft','minecraft',['minecraft.restart']],
  ['busca en nuestras notas cálculo','productivity',['notes.list']],
  ['abre una cooperacha','library',['cooperacha.open']],
] as const)('loads only schemas for the domain in %s', (text, domain, tools) => {
  const result = select(text);
  expect(result.selectedDomains).toContain(domain);
  for (const tool of tools) expect(result.toolNames).toContain(tool);
  expect(result.schemas.length).toBeLessThanOrEqual(20);
  expect(exactFastPathV2(text)).toBeUndefined();
});
it('uses an open poll for a natural vote, without selecting any arguments', () => {
  const result = select('yo voto tacos', { openPoll: true });
  expect(result.toolNames).toContain('polls.vote');
  expect(result).not.toHaveProperty('args');
  expect(result).not.toHaveProperty('execution');
});
it.each(['guarda esto en tu memoria','botsky guarda en tu memoria que me gustan los tacos','acuérdate de que me gustan los tacos','recuerda que me gustan los tacos'])('separates memory semantics from shared notes: %s', text => {
  const result = select(text);
  expect(result.selectedDomains).toContain('productivity');
  expect(result.semanticHints).toEqual(['memory']);
  expect(result.toolNames).toContain('memory.remember');
  // notes.create is always-on, but visibility is never a decision to run it.
  expect(exactFastPathV2(text)).toBeUndefined();
  expect(result).not.toHaveProperty('execute');
});
it.each(['anota en el grupo que hay tacos','crea una nota de tacos','guarda una nota de tacos'])('labels shared notes without execution: %s', text => {
  expect(select(text).semanticHints).toEqual(['shared_notes']);
  expect(exactFastPathV2(text)).toBeUndefined();
});
it('uses current DOCX and recent A_LAST PDF context without loading artifacts or resolving paths', () => {
  expect(select('convierte este docx a pdf', { currentArtifact: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }).toolNames).toContain('media.process');
  expect(select('ahora comprímelo', { recentArtifactContext: [{ kind: 'pdf', mime: 'application/pdf' }] }).toolNames).toContain('media.process');
  expect(select('hazlo', { currentAttachment: { kind: 'document' } }).selectedDomains).toContain('media');
});
it.each(['owner','member'] as const)('exposes nuclear semantics to %s without granting execution', actorRole => {
  const result = select('manda una nuclear de 8 mensajes', { actorRole });
  expect(result.selectedDomains).toContain('messaging');
  expect(result.toolNames).toContain('bulk.nuclear');
  expect(result.schemas.find(schema => schema.name === 'bulk_nuclear')?.description).toContain('permission=bulk.nuclear');
  expect(result.schemas.find(schema => schema.name === 'bulk_nuclear')?.description).toContain('autorización');
  expect(result).not.toHaveProperty('execute');
});
it('does not mistake visibility for permission and omits unrelated admin tools for members', () => {
  expect(select('reinicia minecraft').schemas.find(schema => schema.name === 'minecraft_restart')?.description).toContain('permission=infra.minecraft');
  expect(select('cuota módulos mantenimiento').selectedDomains).not.toContain('admin');
  expect(select('cuota módulos mantenimiento', { actorRole: 'owner' }).toolNames).toContain('control.modules');
});
it('prioritizes session, artifact, active entity, lexical strength, and admin last under contention', () => {
  const text = 'minecraft minecraft minecraft blackjack escuela drive cooperacha nuclear cuota';
  const result = select(text, { actorRole: 'owner', activeSession: { domain: 'school' }, currentArtifact: { kind: 'pdf' }, activeGame: true, openPoll: true, openCooperacha: true });
  expect(result.relevantDomains).toEqual(['core','school','media','games','polls','library','minecraft','drive','messaging','admin']);
  expect(result.schemas).toHaveLength(20);
  expect(result.selectedDomains.slice(0,5)).toEqual(['core','productivity','web','economy','school']);
  expect(result.toolNames).toContain('media.process');
  expect(result.toolNames).not.toContain('control.emergency');
  expect(select('minecraft escuela escuela').relevantDomains.slice(1)).toEqual(['school','minecraft']);
  expect(select('minecraft', { quotedText: 'horario' }).relevantDomains.slice(1)).toEqual(['minecraft','school']);
});
it('never exceeds 20 schemas including meta and never emits internal tools across context combinations', () => {
  expect(MAX_TOOLS_PER_TURN).toBe(20);
  for (const actorRole of ['owner','group_admin','member'] as const) {
    for (const chatType of ['group','private'] as const) {
      for (const domain of capabilityDomains) {
        const result = select('minecraft blackjack escuela notas memoria drive nuclear cooperacha pdf xp cuota encuesta', { actorRole, chatType, activeSession: { domain }, activeGame: true, openPoll: true, openCooperacha: true, currentAttachment: { kind: 'pdf' } });
        expect(result.schemas.length).toBeLessThanOrEqual(20);
        expect(new Set(result.toolNames).size).toBe(result.schemas.length);
        expect(result.toolNames).not.toContain('school.schedule_commit');
        expect(result.toolNames).not.toContain('bulk.confirm');
        expect(result.toolNames).toContain('core.load_capability');
      }
    }
  }
});
it('filters every disabled module, including base tools, sessions, artifacts and expansions', () => {
  for (const disabled of modules) {
    const ctx = input('minecraft blackjack escuela notas memoria drive nuclear cooperacha pdf xp cuota encuesta', { actorRole: 'owner', enabledModules: modules.filter(module => module !== disabled), activeSession: { domain: 'school' }, currentAttachment: { kind: 'docx' }, openPoll: true });
    const result = selectToolExposure(catalog, ctx);
    for (const name of result.toolNames) expect(catalog.find(tool => tool.name === name)?.requiredModule).not.toBe(disabled);
  }
  expect(select('hola', { enabledModules: [] }).toolNames).toEqual(['core.load_capability']);
  expect(new ToolExposureTurn(catalog, input('drive', { enabledModules: ['core'] })).loadCapability({ domain: 'drive' }).status).toBe('not_relevant_or_allowed');
});
it('does not expose group-only tools in private, even when the domain is signaled', () => {
  const result = select('minecraft blackjack encuesta escuela xp nuclear', { chatType: 'private' });
  for (const name of result.toolNames) expect(catalog.find(tool => tool.name === name)?.scope).not.toBe('group');
});
it('allows one backend-owned capability expansion per turn and validates domain/relevance/role', () => {
  expect(MAX_CAPABILITY_EXPANSIONS_PER_TURN).toBe(1);
  const turn = new ToolExposureTurn(catalog, input('hola'));
  expect(turn.loadCapability({ domain: 'unknown' }).status).toBe('invalid_domain');
  expect(turn.loadCapability({ domain: 'games', actorId: 'injected' }).status).toBe('invalid_domain');
  expect(new ToolExposureTurn(catalog, input('hola', { chatType: 'private' })).loadCapability({ domain: 'games' }).status).toBe('not_relevant_or_allowed');
  const discovery = new ToolExposureTurn(catalog, input('hola'));
  expect(discovery.loadCapability({ domain: 'games' }).status).toBe('ok');
  expect(discovery.exposure.toolNames).toContain('games.blackjack');
  expect(discovery.exposure.relevantDomains).toContain('games');
  expect(turn.loadCapability({ domain: 'admin' }).status).toBe('not_relevant_or_allowed');
  expect(turn.loadCapability({ domain: 'productivity' }).status).toBe('ok');
  expect(turn.exposure.toolNames).toContain('notes.list');
  expect(turn.exposure.toolNames).toContain('memory.forget');
  expect(turn.loadCapability({ domain: 'core' }).status).toBe('expansion_limit');
  expect(new ToolExposureTurn(catalog, input('hola')).loadCapability({ domain: 'core' }).status).toBe('ok');
});
it('rotates schemas to expose the whole discovered domain under capacity and freezes input', () => {
  const ctx = input('minecraft');
  const turn = new ToolExposureTurn(catalog, ctx);
  const before = [...turn.exposure.toolNames];
  expect(before).toHaveLength(20);
  expect(turn.loadCapability({ domain: 'minecraft' }).status).toBe('ok');
  expect(turn.exposure.toolNames).toContain('minecraft.console');
  expect(turn.exposure.toolNames).toContain('minecraft.operations');
  expect(turn.exposure.schemas.length).toBeLessThanOrEqual(20);
  ctx.actorRole = 'owner'; ctx.enabledModules = []; ctx.text = 'cuota';
  expect(turn.loadCapability({ domain: 'admin' }).status).toBe('expansion_limit');
  expect(new ToolExposureTurn(catalog,input('hola')).loadCapability({domain:'admin'}).status).toBe('not_relevant_or_allowed');
});

it('keeps reminder editing available after a QR and an open poll fill the context',()=>{
  const result=select('bot cambia el recordatorio de tortillas a las 10 de la noche, el mismo día',{
    openPoll:true,recentArtifactContext:[{kind:'image',mime:'image/png'}],quotedText:'bot haz sticker con ese QR',
  });
  expect(result.toolNames).toContain('reminders.edit');
  expect(result.toolNames).toContain('media.process');
  expect(result.toolNames).toContain('polls.vote');
  expect(result.schemas.length).toBeLessThanOrEqual(20);
});
it.each(['maicra','maincra','mine','mc','bedrock','server','servidor'])('exposes Minecraft for lexical optimization %s without selecting an action',alias=>{
  const result=select(`está activo el ${alias}?`);
  expect(result.toolNames).toContain('minecraft.status');expect(result.toolNames).toContain('minecraft.players');
  expect(result).not.toHaveProperty('args');expect(result.schemas.find(t=>t.name==='minecraft_restart')?.description).toContain('permission=infra.minecraft');
});
it.each(['dame mi daily','mi premio diario','dame mi premio de hoy','dame mi recompensa','giro gratis','cuántos puntos tengo?'])('exposes economy lexical optimization %s',text=>{
  expect(select(text).relevantDomains).toContain('economy');expect(select(text).toolNames).toContain('xp.daily');
});
it('does not select a daily action from an ambiguous giro or replace multimedia with web',()=>{
  expect(select('dame un giro').relevantDomains).not.toContain('economy');expect(select('busca videos de gatos').relevantDomains).toContain('media');
  expect(exactFastPathV2('dame un giro')).toBeUndefined();
});
it('supports AI-First capability discovery via capabilityDirectory when lexical optimization is disabled or for unindexed typos like mimecragt',()=>{
  for(const turnInput of [input('botsky esta activo mimecragt?'),input('hay alguien en el servidor de minecraft',{disableLexicalOptimization:true})]){
    const turn=new ToolExposureTurn(catalog,turnInput);
    expect(turn.exposure.toolNames).not.toContain('minecraft.status');
    expect(turn.exposure.toolNames).toContain('core.load_capability');
    expect(turn.exposure.availableDomains).toContain('minecraft');
    expect(turn.exposure.capabilityDirectory.minecraft).toContain('Minecraft');
    expect(turn.exposure.schemas.find(s=>s.name==='core_load_capability')).toBeDefined();
    expect(turn.loadCapability({domain:'minecraft'}).status).toBe('ok');
    expect(turn.exposure.toolNames).toContain('minecraft.status');
    expect(turn.exposure.toolNames).toContain('minecraft.players');
  }
});
it('exposes pendingTool, core.session_confirm and core.session_cancel for activeSession while preserving Intent Escape',()=>{
  const confirmTurn=select('simon',{activeSession:{domain:'messaging',kind:'confirm',pendingTool:'bulk.nuclear'}});
  expect(confirmTurn.toolNames).toContain('core.session_confirm');
  expect(confirmTurn.toolNames).toContain('core.session_cancel');
  expect(confirmTurn.toolNames).toContain('bulk.nuclear');
  expect(confirmTurn.toolNames).toContain('xp.balance');
  expect(confirmTurn.toolNames).toContain('core.load_capability');
  const clarifyTurn=select('para joi',{activeSession:{domain:'productivity',kind:'clarify',pendingTool:'reminders.create'}});
  expect(clarifyTurn.toolNames).not.toContain('core.session_confirm');
  expect(clarifyTurn.toolNames).toContain('core.session_cancel');
  expect(clarifyTurn.toolNames).toContain('reminders.create');
  expect(clarifyTurn.toolNames).toContain('xp.balance');
  const recentTurn=select('ya no',{hasRecentReminder:true});
  expect(recentTurn.toolNames).toContain('reminders.cancel');
});

