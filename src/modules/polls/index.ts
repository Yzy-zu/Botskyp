import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,type Tool } from '../../core/tools.js';
import { createPoll,vote,results,closePoll } from './service.js';
const base={capability:{produces:'encuesta/votos'},module:'polls',scope:'group',modelCallable:false} as const;
const id=z.string().regex(/^[1-9]\d{0,17}$/);
export const pollTools:Tool[]=[
  defineTool({...base,name:'polls.create',capability:{summary:'Crear encuesta de voto único.',produces:'encuesta'},permission:'polls.manage',risk:'write',description:'Crear encuesta de voto único por texto (owner/admin); duración opcional en minutos.',examples:['bot encuesta ¿Qué comemos? | Tacos | Pizza','bot encuesta 30m ¿Qué comemos? | Tacos | Pizza'],args:z.strictObject({question:z.string().trim().min(1).max(product.pollQuestionChars),options:z.array(z.string().trim().min(1).max(product.pollOptionChars)).min(2).max(product.pollMaxOptions).refine(a=>new Set(a.map(s=>s.toLocaleLowerCase('es-MX'))).size===a.length),minutes:z.number().int().min(1).max(product.pollMaxMinutes).default(product.pollDefaultMinutes)}),run:createPoll}),
  defineTool({...base,name:'polls.vote',capability:{summary:'Emitir/cambiar voto.',produces:'recibo'},permission:'polls.use',risk:'write',description:'Emitir o cambiar tu voto en una encuesta de este grupo.',examples:['bot votar 1 2'],args:z.strictObject({id,option:z.number().int().min(1).max(product.pollMaxOptions)}),run:(ctx,a)=>vote(ctx,a.id,a.option)}),
  defineTool({...base,name:'polls.results',capability:{summary:'Consultar resultados.',produces:'votos'},permission:'polls.use',risk:'read',description:'Consultar resultados de una encuesta del grupo.',examples:['bot encuesta 1'],args:z.strictObject({id}),run:(ctx,a)=>results(ctx.c,ctx.chat.id,a.id)}),
  defineTool({...base,name:'polls.close',capability:{summary:'Cerrar encuesta.',produces:'recibo'},permission:'polls.manage',risk:'write',description:'Cerrar encuesta manualmente (owner/admin).',examples:['bot cerrar encuesta 1'],args:z.strictObject({id}),run:(ctx,a)=>closePoll(ctx,a.id)}),
];
