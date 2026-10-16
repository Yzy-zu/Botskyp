import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import { EconomyError,moveXp,wallet } from '../xp/service.js';
import { cardText,natural,payout,shuffle,total,type Random } from './rules.js';
import { type Game } from './state.js';
export function draw(g:Game):number{
  const card=g.state.deck.pop();if(card===undefined)throw new Error('Exhausted deck');return card;
}
export function beginBlackjack(g:Game,now:Date,random?:Random):void{
  g.state.deck=shuffle(random);g.state.dealer=[draw(g),draw(g)];
  for(const p of g.state.players){p.hand=[draw(g),draw(g)];p.stood=natural(p.hand);}
  g.status='playing';g.state.turn=0;advance(g,now);
}
export function advance(g:Game,now:Date):void{
  while(g.state.turn<g.state.players.length && g.state.players[g.state.turn]!.stood)g.state.turn++;
  g.expires_at=new Date(now.getTime()+(g.state.table?product.blackjackTableSeconds:product.blackjackSoloSeconds)*1000);
}
export async function finishBlackjack(c:PoolClient,g:Game):Promise<boolean>{
  if(g.state.turn<g.state.players.length && !natural(g.state.dealer))return false;
  while(total(g.state.dealer)<product.blackjackDealerStand)g.state.dealer.push(draw(g));
  const results:Record<string,number>={};
  for(const p of [...g.state.players].sort((a,b)=>a.id.localeCompare(b.id))){
    const paid=payout(p.hand,g.state.dealer,p.bet);results[p.id]=paid;
    await moveXp(c,p.id,paid,'payout',g.id,g.chat_id);
  }
  g.state.results=results;g.status='done';return true;
}
export async function blackjackAction(c:PoolClient,g:Game,user:string,action:string,ref:string,now:Date):Promise<void>{
  const p=g.state.players[g.state.turn];
  if(!p || p.id!==user)throw new EconomyError('Todavía no es tu turno.');
  if(action==='doblar'){
    if(p.hand.length!==2 || p.stood)throw new EconomyError('Solo puedes doblar con las dos cartas iniciales.');
    if((await wallet(c,user)).balance<p.bet)throw new EconomyError('No tienes XP suficiente para doblar.');
    await moveXp(c,user,-p.bet,'double',`${g.id}:${ref}`,g.chat_id);p.bet*=2;p.hand.push(draw(g));p.stood=true;
  }else if(action==='carta'){
    p.hand.push(draw(g));if(total(p.hand)>=product.blackjackTarget)p.stood=true;
  }else if(action==='plantarse')p.stood=true;
  else throw new EconomyError('Usa carta, plantarse o doblar.');
  if(p.stood)g.state.turn++;
  advance(g,now);await finishBlackjack(c,g);
}
export function describe(g:Game):string{
  const s=g.state;
  const players=s.players.map(p=>`${p.id}: ${cardText(p.hand)} (${total(p.hand)}), apuesta ${p.bet} XP${s.results?`, devolución ${s.results[p.id] ?? 0} XP`:''}`).join('\n');
  if(g.status==='lobby')return `Mesa blackjack ${g.id}. Apuesta ${s.bet} XP. Lobby ${product.blackjackLobbySeconds} s. Entra con bot entro; cancelar devuelve las reservas.`;
  const house=g.status==='done'?`${cardText(s.dealer)} (${total(s.dealer)})`:cardText(s.dealer.slice(0,1));
  return `Blackjack ${g.id}: ${g.status}.\nDealer: ${house}\n${players}${g.status==='playing'?`\nTurno: ${s.players[s.turn]?.id}. Carta, plantarse o doblar. Plazo: ${g.expires_at.toISOString()}.`:''}`;
}
