import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { transaction } from '../src/db/client.js';
import { moveXp } from '../src/modules/xp/service.js';
import { gameCommand,resolveRoulette } from '../src/modules/games/service.js';
import { saveGame,type Game } from '../src/modules/games/state.js';
import { tickGames } from '../src/modules/games/tick.js';
import { tickCore } from '../src/modules/reminders/tick.js';
import { createRegistry } from '../src/core/registry.js';
import { db,config,owner,admin,member,message,initialize,resetSchool,context,command,execute } from './school-harness.js';
beforeAll(initialize);beforeEach(async()=>{await resetSchool();await db.query('TRUNCATE wallets CASCADE');for(const user of [owner,admin,member])await transaction(db,c=>moveXp(c,user,1000,'seed',user,config.LAB_CHAT_ID));});afterAll(()=>db.end());
const balance=async(user=owner)=>(await db.query<{balance:number}>('SELECT balance FROM wallets WHERE user_id=$1',[user])).rows[0]!.balance;
const current=async()=>(await db.query<Game>('SELECT * FROM games ORDER BY created_at DESC LIMIT 1')).rows[0]!;
const act=(action:Parameters<typeof gameCommand>[1],user=owner)=>context(message('bot juego',user),ctx=>gameCommand(ctx,action,max=>max-1));
async function expire(){await db.query("UPDATE games SET expires_at=clock_timestamp()-interval '1 second' WHERE status IN ('lobby','playing','open')");}
it('individual blackjack reserves once, persists deck and pays a deterministic tie once',async()=>{
  const input=message('bot blackjack');await context(input,ctx=>gameCommand(ctx,{action:'solo'},max=>max-1));
  const before=await current();expect(before.state.deck).toHaveLength(48);expect(await balance()).toBe(950);
  await context(input,ctx=>gameCommand(ctx,{action:'solo'},()=>0));expect((await current()).id).toBe(before.id);expect(await balance()).toBe(950);
  await act({action:'play',move:'plantarse'});expect(await balance()).toBe(1000);expect((await current()).status).toBe('done');
  await tickGames(db,config);expect(await balance()).toBe(1000);
});
it('a repeated action cannot draw a second card',async()=>{
  await act({action:'solo'});const msg=message('carta');await context(msg,ctx=>gameCommand(ctx,{action:'play',move:'carta'}));
  const state=(await current()).state;await context(msg,ctx=>gameCommand(ctx,{action:'play',move:'carta'}));expect((await current()).state).toEqual(state);
});
it('double adds equal reserve, one card and closes the turn',async()=>{
  await act({action:'solo'});await act({action:'play',move:'doblar'});const g=await current();
  expect(g.state.players[0]?.bet).toBe(100);expect(g.state.players[0]?.hand).toHaveLength(3);expect(g.status).toBe('done');expect(await balance()).toBe(900);
});
it('double without sufficient balance changes neither cards nor ledger',async()=>{
  await act({action:'solo',bet:1000});const before=await current();await expect(act({action:'play',move:'doblar'})).rejects.toThrow('suficiente');expect((await current()).state).toEqual(before.state);expect(await balance()).toBe(0);
});
it('double after a hit is rejected',async()=>{
  await act({action:'solo'});const g=await current();g.state.players[0]!.hand=[1,2];await transaction(db,c=>saveGame(c,g));
  await act({action:'play',move:'carta'});await expect(act({action:'play',move:'doblar'})).rejects.toThrow('dos cartas');
});
it('one active game per user and group prevents double reservations',async()=>{
  await act({action:'solo'});await expect(act({action:'solo'})).rejects.toThrow('partida activa');expect(await balance()).toBe(950);expect((await db.query('SELECT * FROM games')).rowCount).toBe(1);
});
it('insufficient initial bet rolls back game and session entirely',async()=>{
  await transaction(db,c=>moveXp(c,owner,-1000,'spend','empty',config.LAB_CHAT_ID));await expect(act({action:'solo'})).rejects.toThrow('suficiente');
  expect((await db.query('SELECT * FROM games')).rowCount).toBe(0);expect((await db.query('SELECT * FROM sessions')).rowCount).toBe(0);
});
it('cancelled lobby refunds every participant exactly once',async()=>{
  await act({action:'table'});await act({action:'join'},member);await act({action:'cancel'});
  expect(await balance()).toBe(1000);expect(await balance(member)).toBe(1000);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='refund'")).rowCount).toBe(2);
  await tickGames(db,config);expect(await balance()).toBe(1000);
});
it('cannot cancel an ongoing individual game to avoid a loss',async()=>{await act({action:'solo'});await expect(act({action:'cancel'})).rejects.toThrow('lobby');expect(await balance()).toBe(950);});
it('nonparticipants cannot act and another group cannot see this game',async()=>{
  await act({action:'solo'});await expect(act({action:'play',move:'plantarse'},member)).rejects.toThrow('partida');
  await expect(context(message('bot partida',owner,'400@g.us'),ctx=>gameCommand(ctx,{action:'status'}))).rejects.toThrow('partida');
});
it('table has six players maximum',async()=>{
  await act({action:'table'});
  for(let i=1;i<=5;i++){const id=`${800+i}@s.whatsapp.net`;await transaction(db,c=>moveXp(c,id,50,'seed',id,config.LAB_CHAT_ID));await act({action:'join'},id);}
  await expect(act({action:'join'},member)).rejects.toThrow('llena');expect(await balance(member)).toBe(1000);
});
it('lobby deadline deals the table and turn timeout stands automatically after restart of tick',async()=>{
  await act({action:'table'});await act({action:'join'},member);await expire();await tickCore(db,config);await tickGames(db,config);
  let g=await current();expect(['playing','done']).toContain(g.status);
  while(g.status==='playing'){await expire();await tickCore(db,config);await Promise.all([tickGames(db,config),tickGames(db,config)]);g=await current();}
  expect(g.status).toBe('done');expect((await db.query("SELECT * FROM xp_ledger WHERE reason='payout'")).rowCount).toBe(2);
  expect((await db.query("SELECT * FROM sessions WHERE status='active' AND kind='game'")).rowCount).toBe(0);
});
it('game continuation sessions survive a deadline until game tick takes its turn',async()=>{
  await act({action:'solo'});await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");await tickCore(db,config);
  expect((await db.query("SELECT * FROM sessions WHERE status='active' AND kind='game'")).rowCount).toBe(1);
  expect(await command('estado')).toContain('Blackjack');
});
it('unfinished clarification cannot be overwritten by entering a game',async()=>{
  await command('bot recuérdame tarea');await expect(act({action:'solo'})).rejects.toThrow('interacción');expect(await balance()).toBeGreaterThanOrEqual(1000);
});
it('roulette without two players refunds on lobby expiry',async()=>{await act({action:'roulette'});await expire();await tickGames(db,config);expect(await balance()).toBe(1000);expect((await current()).status).toBe('cancelled');});
it('roulette loser chosen in code, pot conserved with explicit remainder',async()=>{
  await act({action:'roulette',bet:51});await act({action:'join'},member);await act({action:'join'},admin);
  const g=await current();await transaction(db,c=>resolveRoulette({c},g,()=>1));
  expect((await current()).state.loser).toBe(member);expect(await balance(member)).toBe(949);expect(await balance()).toBe(1025);expect(await balance(admin)).toBe(1025);expect(await balance('system:community')).toBe(1);
});
it('roulette without bot admin explicitly announces no consequences and creates no warns',async()=>{
  await execute('moderation.config',{enabled:true});expect(await act({action:'roulette'})).toContain('Sin consecuencias');await act({action:'join'},member);
  await transaction(db,async c=>resolveRoulette({c},await current(),()=>0));expect((await db.query('SELECT * FROM moderation_events')).rowCount).toBe(0);
});
it('roulette advertises consequences before join and loss records exactly one warn',async()=>{
  await execute('moderation.config',{enabled:true});await db.query("INSERT INTO users(id) VALUES('200@s.whatsapp.net')");await db.query("INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES('300@g.us','200@s.whatsapp.net',true)");
  expect(await act({action:'roulette'})).toContain('Quien pierda recibe un warn');
  await db.query("INSERT INTO outbox(chat_id,status,payload,dedupe_key) SELECT chat_id,'sent',jsonb_build_object('text','Quien pierda recibe un warn; al tercero sale','sourceId',source_id),'announcement:'||id FROM games");
  await act({action:'join'},member);await expire();await Promise.all([tickGames(db,config),tickGames(db,config)]);
  expect((await db.query("SELECT * FROM moderation_events WHERE kind='warn'")).rowCount).toBe(1);
});
it('airdrop only awards one winner under concurrent claims and cannot be reopened to mint freely',async()=>{
  await act({action:'airdrop'});const results=await Promise.allSettled([act({action:'claim'},member),act({action:'claim'},admin)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='airdrop'")).rowCount).toBe(1);expect(await balance(member)+await balance(admin)).toBe(2500);
  await expect(act({action:'airdrop'})).rejects.toThrow('última hora');
});
it('expired airdrop has no winner and claim retry never pays twice',async()=>{
  await act({action:'airdrop'});await expire();await expect(act({action:'claim'},member)).rejects.toThrow('disponible');await tickGames(db,config);expect((await current()).status).toBe('expired');
});
it('airdrop creation is administrative and model cannot place bets, choose winner or mint XP',async()=>{
  expect((await execute('games.airdrop',{},member)).ok).toBe(false);
  await context(message('bot juego'),async ctx=>{expect(createRegistry().declarations(ctx).some(t=>t.name.startsWith('games_'))).toBe(false);expect((await createRegistry().execute(ctx,'games.blackjack',{bet:50},'model')).ok).toBe(false);});
  expect((await execute('games.blackjack',{bet:50,winner:owner})).ok).toBe(false);
});
it('disabled games rejects tools, refunds outstanding reservations and keeps real groups blocked',async()=>{
  await act({action:'table'});await execute('control.modules',{module:'games',enabled:false});expect((await execute('games.join',{},member)).ok).toBe(false);
  await expire();await tickGames(db,config);expect(await balance()).toBe(1000);
  expect(await command(message('bot blackjack',owner,'400@g.us'))).toBeUndefined();
});
it('deterministic commands and unprefixed participant actions are routed without Gemini',async()=>{
  expect(await command('bot blackjack mesa 20')).toContain('Mesa blackjack');expect(await command('bot entro',member)).toContain('Entraste');expect(await command('cancelar')).toContain('Reservas devueltas');
});
it('administrators can cancel another creator lobby but a member cannot',async()=>{
  await act({action:'table'},member);await expect(act({action:'cancel'},'700@s.whatsapp.net')).rejects.toThrow('partida');await act({action:'cancel'},admin);expect(await balance(member)).toBe(1000);
});
it('roulette settlement rolls back payouts and state together then can retry safely',async()=>{
  await act({action:'roulette'});await act({action:'join'},member);const g=await current();
  await expect(transaction(db,async c=>{await resolveRoulette({c},g,()=>0);throw new Error('crash');})).rejects.toThrow('crash');
  expect((await current()).status).toBe('lobby');expect(await balance()).toBe(950);expect(await balance(member)).toBe(950);
  await transaction(db,async c=>resolveRoulette({c},await current(),()=>0));expect(await balance(member)).toBe(1050);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='payout'")).rowCount).toBe(2);
});
it('roulette cannot apply an announced consequence until outbox proves publication',async()=>{
  await execute('moderation.config',{enabled:true});await db.query("INSERT INTO users(id) VALUES('200@s.whatsapp.net')");await db.query("INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES('300@g.us','200@s.whatsapp.net',true)");
  await act({action:'roulette'});await act({action:'join'},member);const g=await current();expect(g.state.consequences).toBe(true);
  const reply=await transaction(db,c=>resolveRoulette({c},g,()=>0));expect(reply).toContain('no se confirmó');expect((await db.query('SELECT * FROM moderation_events')).rowCount).toBe(0);
});
it('a generic no or terminar cannot pretend to cancel a reserved running game',async()=>{
  await act({action:'solo'});expect(await command('bot terminar')).toContain('sigue activa');expect(await command('bot no')).toContain('sigue activa');expect((await current()).status).toBe('playing');
});
it('tick skips a busy chat immediately and resumes after the transaction releases it',async()=>{
  await act({action:'solo'});await expire();const c=await db.connect();
  try{
    await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`games:${config.LAB_CHAT_ID}`]);
    const before=Date.now();await tickGames(db,config);expect(Date.now()-before).toBeLessThan(1000);expect((await current()).status).toBe('playing');
    await c.query('COMMIT');await tickGames(db,config);expect((await current()).status).toBe('done');
  }finally{await c.query('ROLLBACK');c.release();}
});
