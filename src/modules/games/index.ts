import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,ok,type Tool } from '../../core/tools.js';
import { gameCommand } from './service.js';
const base={module:'games',permission:'games.use',scope:'group',modelCallable:false,risk:'write'} as const;
const bet=z.number().int().min(product.gameMinBet).max(product.gameMaxBet).optional();
export const gameTools:Tool[]=[
  defineTool({...base,name:'games.blackjack',description:'Blackjack individual o mesa; reserva XP al entrar.',examples:['bot blackjack 50','bot blackjack mesa 50'],args:z.strictObject({bet,table:z.boolean().optional()}),async run(ctx,args){return ok(await gameCommand(ctx,{action:args.table?'table':'solo',...(args.bet!==undefined?{bet:args.bet}:{})}));}}),
  defineTool({...base,name:'games.roulette',description:'Ruleta con apuesta y consecuencias anunciadas.',examples:['bot ruleta 50'],args:z.strictObject({bet}),async run(ctx,args){return ok(await gameCommand(ctx,{action:'roulette',...(args.bet!==undefined?{bet:args.bet}:{})}));}}),
  defineTool({...base,name:'games.join',description:'Entrar al lobby de este grupo.',examples:['bot entro'],args:z.strictObject({}),async run(ctx){return ok(await gameCommand(ctx,{action:'join'}));}}),
  defineTool({...base,name:'games.play',description:'Continuar tu turno de blackjack.',examples:['bot carta','bot plantarse','bot doblar'],args:z.strictObject({move:z.enum(['carta','plantarse','doblar'])}),async run(ctx,args){return ok(await gameCommand(ctx,{action:'play',move:args.move}));}}),
  defineTool({...base,name:'games.status',risk:'read',description:'Consultar tu partida activa.',examples:['bot partida'],args:z.strictObject({}),async run(ctx){return ok(await gameCommand(ctx,{action:'status'}));}}),
  defineTool({...base,name:'games.cancel',description:'Cancelar tu lobby y devolver reservas.',examples:['bot partida cancelar'],args:z.strictObject({}),async run(ctx){return ok(await gameCommand(ctx,{action:'cancel'}));}}),
  defineTool({...base,name:'games.airdrop',permission:'chat.configure',description:'Abrir airdrop de 500 XP; máximo uno por hora.',examples:['bot airdrop'],args:z.strictObject({}),async run(ctx){return ok(await gameCommand(ctx,{action:'airdrop'}));}}),
  defineTool({...base,name:'games.claim',description:'Reclamar el airdrop abierto; un único ganador.',examples:['bot yoo'],args:z.strictObject({}),async run(ctx){return ok(await gameCommand(ctx,{action:'claim'}));}}),
];
