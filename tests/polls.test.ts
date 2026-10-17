import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { createRegistry } from '../src/core/registry.js';
import { tickPolls } from '../src/modules/polls/service.js';
import { db,config,owner,admin,member,initialize,resetSchool,execute,context,message,command } from './school-harness.js';
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
const create=()=>execute('polls.create',{question:'¿Qué comemos?',options:['Tacos','Pizza']});
async function pollId(){await create();return (await db.query<{id:string}>('SELECT id FROM polls ORDER BY id DESC LIMIT 1')).rows[0]!.id;}
const votes=async()=> (await db.query<{voter_id:string;option_idx:number}>('SELECT voter_id,option_idx FROM poll_votes ORDER BY voter_id')).rows;
it('creates a persistent textual poll without Gemini',async()=>{
  const reply=await command('bot encuesta ¿Qué comemos? | Tacos | Pizza');expect(reply).toContain('¿Qué comemos?');expect(reply).toContain('1. Tacos: 0');
  const poll=(await db.query('SELECT * FROM polls')).rows[0];expect(poll.chat_id).toBe(config.LAB_CHAT_ID);expect(poll.author_id).toBe(owner);expect(poll.multi).toBe(false);expect((await db.query('SELECT * FROM llm_usage')).rowCount).toBe(0);
});
it('supports deterministic duration, vote and result commands',async()=>{
  await command('bot encuesta 30m Pregunta | Una | Dos');const id=(await db.query('SELECT id FROM polls')).rows[0].id as string;
  expect(await command(`bot votar ${id} 2`,member)).toContain('opción 2');expect(await command(`bot encuesta ${id}`,member)).toContain('2. Dos: 1');
  const left=(await db.query<{seconds:number}>('SELECT extract(epoch FROM closes_at-clock_timestamp())::int seconds FROM polls')).rows[0]!.seconds;expect(left).toBeGreaterThan(1700);expect(left).toBeLessThanOrEqual(1800);
});
it('allows a member to vote but only owner/admin create and close',async()=>{
  expect((await execute('polls.create',{question:'q',options:['a','b']},member)).ok).toBe(false);
  expect((await execute('polls.create',{question:'q',options:['a','b']},admin)).ok).toBe(true);
  const id=(await db.query('SELECT id FROM polls')).rows[0].id as string;
  expect((await execute('polls.vote',{id,option:1},member)).ok).toBe(true);expect((await execute('polls.close',{id},member)).ok).toBe(false);expect((await execute('polls.close',{id},admin)).ok).toBe(true);
});
it('one voter has one effective vote and can change it',async()=>{
  const id=await pollId();await execute('polls.vote',{id,option:1},member);await execute('polls.vote',{id,option:1},member);expect(await votes()).toEqual([{voter_id:member,option_idx:1}]);
  await execute('polls.vote',{id,option:2},member);expect(await votes()).toEqual([{voter_id:member,option_idx:2}]);expect((await execute('polls.results',{id},member))).toMatchObject({ok:true,reply:expect.stringContaining('2. Pizza: 1')});
});
it('replaying an old vote after a change never reverts the latest choice',async()=>{
  const id=await pollId();const old=message('bot votar',member);
  const cast=()=>context(old,ctx=>createRegistry().execute(ctx,'polls.vote',{id,option:1}));
  await cast();await execute('polls.vote',{id,option:2},member);await cast();expect(await votes()).toEqual([{voter_id:member,option_idx:2}]);
});
it('concurrent same-message creation is idempotent',async()=>{
  const msg=message('bot encuesta');const create=()=>context(msg,ctx=>createRegistry().execute(ctx,'polls.create',{question:'q',options:['a','b']}));
  await Promise.all([create(),create()]);expect((await db.query('SELECT * FROM polls')).rowCount).toBe(1);
});
it('concurrent votes from the same actor still count once',async()=>{
  const id=await pollId();await Promise.all([execute('polls.vote',{id,option:1},member),execute('polls.vote',{id,option:2},member)]);expect(await votes()).toHaveLength(1);
});
it('closes manually idempotently and rejects later votes',async()=>{
  const id=await pollId();expect(await command(`bot cerrar encuesta ${id}`)).toContain('Cerrada');expect((await execute('polls.close',{id})).ok).toBe(true);expect((await execute('polls.vote',{id,option:1},member)).ok).toBe(false);
});
it('expires through a concurrent tick exactly once and rejects votes before tick',async()=>{
  const id=await pollId();await db.query("UPDATE polls SET closes_at=now()-interval '1 minute'");expect((await execute('polls.vote',{id,option:1},member)).ok).toBe(false);
  await Promise.all([tickPolls(db,config),tickPolls(db,config)]);await tickPolls(db,config);expect((await db.query('SELECT status FROM polls')).rows[0]?.status).toBe('closed');expect((await db.query("SELECT * FROM outbox WHERE kind='poll_result'")).rowCount).toBe(1);
});
it.each(['disabled chat','disabled module','emergency','maintenance'])('expires without announcing in %s',async kind=>{
  await pollId();await db.query("UPDATE polls SET closes_at=now()-interval '1 minute'");
  if(kind==='disabled chat')await db.query('UPDATE chats SET enabled=false');
  else if(kind==='disabled module')await db.query(`UPDATE chats SET settings='{"modules":{"polls":false}}'`);
  else await db.query('INSERT INTO system_flags(key,value) VALUES($1,\'true\')',[kind]);
  await tickPolls(db,config);expect((await db.query('SELECT status FROM polls')).rows[0]?.status).toBe('closed');expect((await db.query("SELECT * FROM outbox WHERE kind='poll_result'")).rowCount).toBe(0);
});
it('isolates ids and votes across chats even with an explicitly enabled module',async()=>{
  const id=await pollId();await db.query(`UPDATE chats SET settings='{"modules":{"polls":true}}' WHERE id='400@g.us'`);
  for(const name of ['polls.results','polls.close'])expect((await execute(name,{id},owner,'400@g.us')).ok).toBe(false);
  expect((await execute('polls.vote',{id,option:1},owner,'400@g.us')).ok).toBe(false);expect(await votes()).toHaveLength(0);
});
it('requires current membership and is unavailable in private chats or Gemini',async()=>{
  const id=await pollId();await db.query('UPDATE group_memberships SET active=false WHERE user_id=$1',[member]);expect((await execute('polls.vote',{id,option:1},member)).ok).toBe(false);
  expect((await execute('polls.create',{question:'q',options:['a','b']},owner,owner)).ok).toBe(false);
  await context(message('test'),async ctx=>{expect(createRegistry().declarations(ctx).some(t=>t.name.startsWith('polls_'))).toBe(false);expect((await createRegistry().execute(ctx,'polls.close',{id},'model')).ok).toBe(false);});
});
it.each([{question:'',options:['a','b']},{question:'q',options:['a']},{question:'q',options:['a','A']},{question:'q',options:['a','b'],minutes:0},{question:'q',options:['a','b'],actorId:member},{question:'q',options:['a','b'],chatId:'400@g.us'}])('rejects invalid creation arguments %#',async args=>{expect((await execute('polls.create',args)).ok).toBe(false);expect((await db.query('SELECT * FROM polls')).rowCount).toBe(0);});
it.each([0,3,-1,1.5])('rejects invalid option %i without mutation',async option=>{const id=await pollId();expect((await execute('polls.vote',{id,option},member)).ok).toBe(false);expect(await votes()).toHaveLength(0);});

it('unresolved LIDs cannot split a vote before and after verified identity resolution',async()=>{
  const id=await pollId();await db.query("INSERT INTO users(id) VALUES('901@lid')");await db.query("INSERT INTO group_memberships(chat_id,user_id) VALUES('300@g.us','901@lid')");
  expect((await execute('polls.vote',{id,option:1},'901@lid')).ok).toBe(false);expect(await votes()).toHaveLength(0);
  await db.query("INSERT INTO user_aliases(alias,user_id,evidence) VALUES('901@lid',$1,'provider_participants')",[member]);
  expect((await execute('polls.vote',{id,option:1},'901@lid')).ok).toBe(true);await execute('polls.vote',{id,option:2},member);expect(await votes()).toEqual([{voter_id:member,option_idx:2}]);
});
