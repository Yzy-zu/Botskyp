import { randomInt } from 'node:crypto';
import { product } from '../../../config/product.js';
export type Random=(max:number)=>number;
export function shuffle(random:Random=randomInt):number[]{
  const deck=Array.from({length:52},(_,i)=>i);
  for(let i=deck.length-1;i>0;i--){const j=random(i+1);[deck[i],deck[j]]=[deck[j]!,deck[i]!];}
  return deck;
}
export function total(cards:number[]):number{
  let value=cards.reduce((sum,c)=>sum+Math.min(c%13+1,10),0);
  if(cards.some(c=>c%13===0) && value+10<=product.blackjackTarget)value+=10;
  return value;
}
export const natural=(cards:number[]):boolean=>cards.length===2 && total(cards)===product.blackjackTarget;
export function payout(hand:number[],dealer:number[],bet:number):number{
  const player=total(hand),house=total(dealer);
  if(player>product.blackjackTarget)return 0;
  if(natural(dealer))return natural(hand)?bet:0;
  if(natural(hand))return Math.floor(bet*product.blackjackNaturalRate);
  if(house>product.blackjackTarget || player>house)return bet*2;
  return player===house?bet:0;
}
export function rouletteSplit(bets:number[],loser:number):{each:number;remainder:number}{
  const pot=bets.reduce((a,b)=>a+b,0),winners=bets.length-1;
  if(winners<1 || loser<0 || loser>=bets.length)throw new Error('Invalid roulette');
  return {each:Math.floor(pot/winners),remainder:pot%winners};
}
export const cardText=(cards:number[]):string=>cards.map(c=>`${['A','2','3','4','5','6','7','8','9','10','J','Q','K'][c%13]}${['♠','♥','♦','♣'][Math.floor(c/13)]}`).join(' ');
