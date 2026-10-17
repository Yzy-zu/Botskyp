import { reserveAirdrop,claimAirdrop } from '../packs/airdrop.js';
import { randomInt,randomUUID } from 'node:crypto';
import { product } from '../../../config/product.js';
import type { ToolCtx } from '../../core/tools.js';
import { EconomyError,moveXp } from '../xp/service.js';
import { rouletteWarn } from '../moderation/service.js';
import { moduleEnabled } from '../../core/permissions.js';
import { botAdmin,EvolutionGroups,type GroupControl } from '../../wa/group-control.js';
import { beginBlackjack,blackjackAction,describe,finishBlackjack } from './blackjack.js';
import { rouletteSplit,type Random } from './rules.js';
import { chatLock,lockChatWallets,enqueue,gameSession,initialState,loadGame,saveGame,type Game } from './state.js';
export type GameCommand={action:'solo'|'table'|'roulette'|'join'|'play'|'cancel'|'status'|'airdrop'|'claim';bet?:number;move?:string};
export async function cancelGame(ctx:Pick<ToolCtx,'c'>,g:Game):Promise<void>{
  for(const p of [...g.state.players].sort((a,b)=>a.id.localeCompare(b.id)))await moveXp(ctx.c,p.id,p.bet,'refund',g.id,g.chat_id);
  g.status='cancelled';await saveGame(ctx.c,g);
}
async function addPlayer(ctx:ToolCtx,g:Game):Promise<void>{
  if(g.state.players.some(p=>p.id===ctx.actor.id))throw new EconomyError('Ya estás dentro de esta partida.');
  if(g.state.players.length>=product.gameMaxPlayers)throw new EconomyError('La mesa está llena.');
  if((await ctx.c.query('SELECT 1 FROM game_players WHERE chat_id=$1 AND user_id=$2 AND active',[g.chat_id,ctx.actor.id])).rowCount)throw new EconomyError('Ya tienes una partida activa aquí.');
  if((await ctx.c.query("SELECT 1 FROM sessions WHERE chat_id=$1 AND owner_id=$2 AND status='active' AND expires_at>clock_timestamp()",[g.chat_id,ctx.actor.id])).rowCount)throw new EconomyError('Termina tu interacción pendiente antes de entrar.');
  await moveXp(ctx.c,ctx.actor.id,-g.state.bet,'bet',g.id,g.chat_id);
  g.state.players.push({id:ctx.actor.id,bet:g.state.bet,hand:[],stood:false});
  await ctx.c.query('INSERT INTO game_players(game_id,chat_id,user_id) VALUES($1,$2,$3)',[g.id,g.chat_id,ctx.actor.id]);
  await gameSession(ctx.c,g,ctx.actor.id);
}
export async function resolveRoulette(ctx:Pick<ToolCtx,'c'>,g:Game,random:Random=randomInt):Promise<string>{
  const players=g.state.players;
  if(players.length<product.rouletteMinPlayers){await cancelGame(ctx,g);return `Ruleta ${g.id} cancelada: faltan participantes. Reservas devueltas.`;}
  const loser=random(players.length),split=rouletteSplit(players.map(p=>p.bet),loser);
  const results:Record<string,number>={};
  const amounts=players.map((p,i)=>({id:p.id,xp:i===loser?0:split.each}));
  if(split.remainder)amounts.push({id:'system:community',xp:split.remainder});
  for(const p of amounts.sort((a,b)=>a.id.localeCompare(b.id))){await moveXp(ctx.c,p.id,p.xp,p.id==='system:community'?'community_remainder':'payout',g.id,g.chat_id);results[p.id]=p.xp;}
  g.state.loser=players[loser]!.id;g.state.results=results;g.status='done';
  let warning='Sin consecuencias.';
  if(g.state.consequences){
    const announced=await ctx.c.query("SELECT 1 FROM games g JOIN outbox o ON o.chat_id=g.chat_id AND o.payload->>'sourceId'=g.source_id WHERE g.id=$1 AND o.status='sent' AND o.payload->>'text' LIKE '%Quien pierda recibe un warn;%'",[g.id]);
    if(!announced.rowCount){g.state.consequences=false;warning='Sin consecuencias: no se confirmó la entrega del anuncio.';}
  }
  if(g.state.consequences){const count=await rouletteWarn(ctx.c,g.chat_id,g.state.loser,g.id,g.state.punishmentMinutes);warning=`${count} warns. Si corresponde castigo, se verificará y tramitará; todavía no se confirma expulsión.`;}
  await saveGame(ctx.c,g);
  return `Ruleta ${g.id}. Pierde ${g.state.loser}. Supervivientes: ${split.each} XP cada uno. Comunidad: ${split.remainder} XP. ${warning}`;
}
export async function gameCommand(ctx:ToolCtx,args:GameCommand,random?:Random,groups?:GroupControl):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);await lockChatWallets(ctx.c,ctx.chat.id,ctx.actor.id);
  const prior=await ctx.c.query<{reply:string}>('SELECT reply FROM game_actions WHERE chat_id=$1 AND user_id=$2 AND source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id]);
  if(prior.rows[0])return prior.rows[0].reply;
  let g:Game|undefined,reply:string;
  if(['solo','table','roulette','airdrop'].includes(args.action)){
    const bet=args.bet ?? product.gameBet;
    if(!Number.isInteger(bet) || bet<product.gameMinBet || bet>product.gameMaxBet)throw new EconomyError('Apuesta fuera de rango.');
    if(args.action==='airdrop'){
      const recent=await ctx.c.query('SELECT 1 FROM games WHERE chat_id=$1 AND kind=\'airdrop\' AND created_at>clock_timestamp()-$2::int*interval \'1 millisecond\'',[ctx.chat.id,product.airdropCooldownMs]);
      if(recent.rowCount)throw new EconomyError('Ya hubo un airdrop en la última hora.');
    }else if((await ctx.c.query("SELECT 1 FROM games WHERE chat_id=$1 AND status='lobby'",[ctx.chat.id])).rowCount)throw new EconomyError('Ya hay un lobby abierto en este grupo.');
    const state=initialState(bet,args.action==='table');
    if(args.action==='roulette'){
      const setting=(await ctx.c.query<{enabled:boolean;minutes:number|null}>("SELECT coalesce((settings->>'roulette_warns')::boolean,false) AS enabled,(settings->>'roulette_punishment_minutes')::int AS minutes FROM chats WHERE id=$1",[ctx.chat.id])).rows[0]!;
      state.punishmentMinutes=setting.minutes ?? product.roulettePunishmentMinutes;
      if(setting.enabled && moduleEnabled(ctx.chat,'moderation',ctx.config)){
        if(ctx.config.TRANSPORT==='evolution' || groups){
          try{state.consequences=botAdmin(await (groups ?? new EvolutionGroups(ctx.config,ctx.c)).roster(ctx.chat.id),ctx.config);}catch{state.consequences=false;}
        }else{
          const bot=await ctx.c.query('SELECT 1 FROM group_memberships WHERE chat_id=$1 AND user_id=ANY($2::text[]) AND active AND is_admin AND last_seen_at>clock_timestamp()-$3::int*interval \'1 millisecond\'',[ctx.chat.id,ctx.config.BOT_JIDS,product.membershipMaxAgeMs]);state.consequences=Boolean(bot.rowCount);
        }
      }
    }
    const kind=args.action==='roulette'?'roulette':args.action==='airdrop'?'airdrop':'blackjack';
    const seconds=kind==='roulette'?product.rouletteLobbySeconds:kind==='airdrop'?product.airdropSeconds:args.action==='table'?product.blackjackLobbySeconds:product.blackjackSoloSeconds;
    g={id:randomUUID(),chat_id:ctx.chat.id,owner_id:ctx.actor.id,kind,status:kind==='airdrop'?'open':args.action==='solo'?'playing':'lobby',state,version:0,expires_at:new Date(ctx.now.getTime()+seconds*1000)};
    await ctx.c.query('INSERT INTO games(id,chat_id,owner_id,kind,status,state,source_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[g.id,g.chat_id,g.owner_id,g.kind,g.status,JSON.stringify(state),ctx.msg.id,g.expires_at]);
    if(kind==='airdrop')await reserveAirdrop(ctx,g.id);
    else await addPlayer(ctx,g);
    if(args.action==='solo'){beginBlackjack(g,ctx.now,random);await finishBlackjack(ctx.c,g);}
    await saveGame(ctx.c,g);
    reply=kind==='blackjack'?describe(g):kind==='airdrop'?`Airdrop ${g.id}: ${product.airdropXp} XP al primero que diga bot yoo. Vence ${g.expires_at.toISOString()}. Un ganador y pack privado reservado.`:
      `Ruleta ${g.id}: apuesta ${bet} XP, lobby ${seconds} s. Entra con bot entro. ${state.consequences?`Quien pierda recibe un warn; al tercero, sale temporalmente ${state.punishmentMinutes} minutos. Owner/admin no se expulsan.`:'Sin consecuencias: deshabilitadas o bot sin administración comprobada.'}`;
  }else if(args.action==='claim'){
    g=(await ctx.c.query<Game>("SELECT * FROM games WHERE chat_id=$1 AND kind='airdrop' AND status='open' AND expires_at>clock_timestamp() FOR UPDATE",[ctx.chat.id])).rows[0];
    if(!g)throw new EconomyError('No hay airdrop disponible.');
    g.state=initialState();g.state.winner=ctx.actor.id;
    const claimed=await ctx.c.query("UPDATE games SET status='claimed',state=$2,version=version+1 WHERE id=$1 AND status='open' RETURNING id",[g.id,JSON.stringify(g.state)]);
    if(!claimed.rowCount)throw new EconomyError('El airdrop ya fue reclamado.');
    await claimAirdrop(ctx,g.id);
    await moveXp(ctx.c,ctx.actor.id,product.airdropXp,'airdrop',g.id,g.chat_id);reply=`Ganaste ${product.airdropXp} XP del airdrop ${g.id}. Pack privado en cola; entrega aún no confirmada.`;
  }else{
    if(args.action==='join')g=(await ctx.c.query<Game>("SELECT * FROM games WHERE chat_id=$1 AND status='lobby' FOR UPDATE",[ctx.chat.id])).rows[0];
    else g=await loadGame(ctx.c,ctx.chat.id,undefined,ctx.actor.id);
    if(!g && args.action==='cancel' && ['owner','group_admin'].includes(ctx.actor.role))g=(await ctx.c.query<Game>("SELECT * FROM games WHERE chat_id=$1 AND status='lobby' FOR UPDATE",[ctx.chat.id])).rows[0];
    if(!g)throw new EconomyError('No tienes una partida disponible aquí.');
    if(g.expires_at.getTime()<=ctx.now.getTime())throw new EconomyError('El plazo venció; espera el cierre automático.');
    if(args.action==='join'){await addPlayer(ctx,g);await saveGame(ctx.c,g);reply=`Entraste a ${g.id}. Reserva: ${g.state.bet} XP. ${g.kind==='roulette'?(g.state.consequences?`Warn al perdedor; al tercero, castigo ${g.state.punishmentMinutes} min. Owner/admin inmunes.`:'Sin consecuencias.'):'Espera el cierre del lobby.'}`;}
    else if(args.action==='cancel'){
      if(g.status!=='lobby' || (g.owner_id!==ctx.actor.id && !['owner','group_admin'].includes(ctx.actor.role)))throw new EconomyError('Solo se puede cancelar el lobby por su creador o administrador.');
      await cancelGame(ctx,g);reply=`Lobby ${g.id} cancelado. Reservas devueltas.`;
    }else if(args.action==='play'){
      if(g.kind!=='blackjack' || g.status!=='playing')throw new EconomyError('No hay turno de blackjack activo.');
      await blackjackAction(ctx.c,g,ctx.actor.id,args.move ?? '',ctx.msg.id,ctx.now);await saveGame(ctx.c,g);reply=describe(g);
    }else reply=g.kind==='blackjack'?describe(g):`Ruleta ${g.id}, ${g.state.players.length} participantes; vence ${g.expires_at.toISOString()}.`;
  }
  await ctx.c.query('INSERT INTO game_actions(chat_id,user_id,source_id,game_id,reply) VALUES($1,$2,$3,$4,$5)',[ctx.chat.id,ctx.actor.id,ctx.msg.id,g.id,reply]);
  return reply;
}
export async function gameNotice(ctx:Pick<ToolCtx,'c'>,g:Game,text:string):Promise<void>{await enqueue(ctx.c,g.chat_id,`game:${g.id}:${g.version}`,text);}
