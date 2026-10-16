import { expect,it } from 'vitest';
import { shuffle,total,natural,payout,rouletteSplit } from '../src/modules/games/rules.js';
it('shuffle preserves exactly 52 distinct cards with injectable randomness',()=>{
  const deck=shuffle(max=>max-1);expect(deck).toEqual(Array.from({length:52},(_,i)=>i));
  expect(new Set(shuffle()).size).toBe(52);
});
it.each([[[0,13,9],12],[[0,8],20],[[0,9],21],[[0,13,26,39],14],[[9,10,11],30]])('aces are soft only when safe (%j)',(cards,value)=>expect(total(cards)).toBe(value));
it('three-card 21 is not natural',()=>{expect(natural([0,9])).toBe(true);expect(natural([0,4,4])).toBe(false);});
it.each([
  [[0,9],[8,7],51,127],[[0,9],[13,22],50,50],[[8,7],[0,9],50,0],
  [[9,8],[7,8],50,100],[[9,8],[22,21],50,50],[[9,10,11],[9,10,11],50,0],
  [[9,7],[9,10,11],50,100],[[9,7],[9,8],50,0],
])('payout for hand %j versus dealer %j',(hand,dealer,bet,paid)=>expect(payout(hand,dealer,bet)).toBe(paid));
it('roulette conserves pot including community remainder',()=>{
  const result=rouletteSplit([51,51,51],1);expect(result).toEqual({each:76,remainder:1});expect(result.each*2+result.remainder).toBe(153);
});
