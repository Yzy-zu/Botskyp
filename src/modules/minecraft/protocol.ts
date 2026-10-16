import { z } from 'zod';
import { product } from '../../../config/product.js';
const empty=z.strictObject({});
export const consoleCommand=z.enum(['list','time query daytime','time set day','time set night','weather clear','weather rain']);
export const configKey=z.enum(['difficulty','gamemode','max-players','pvp','allow-cheats']);
export const configValue=z.enum(['peaceful','easy','normal','hard','survival','creative','adventure','true','false','1','2','3','4','5','6','7','8','9','10','12','16','20']);
export const schemas={
  status:empty,players:empty,resources:empty,worlds:empty,addons:empty,
  logs:z.strictObject({lines:z.number().int().min(1).max(product.minecraftLogLines).default(30)}),
  'config-get':empty,
  'config-set':z.strictObject({key:configKey,value:configValue}).refine(({key,value})=>
    key==='difficulty'?['peaceful','easy','normal','hard'].includes(value):
    key==='gamemode'?['survival','creative','adventure'].includes(value):
    key==='max-players'?/^\d+$/.test(value):['true','false'].includes(value)),
  start:empty,stop:empty,restart:empty,backup:empty,
  console:z.strictObject({command:consoleCommand}),
} as const;
export type Action=keyof typeof schemas;
export const actionSchema=z.enum(Object.keys(schemas) as [Action,...Action[]]);
export const requestSchema=z.strictObject({action:actionSchema,args:z.unknown()}).transform(({action,args},ctx)=>{
  const parsed=schemas[action].safeParse(args);
  if(!parsed.success){ctx.addIssue({code:'custom',message:'Invalid Minecraft arguments'});return z.NEVER;}
  return {action,args:parsed.data};
});
export type Request=z.infer<typeof requestSchema>;
export const writeAction=(action:Action):boolean=>['start','stop','restart','backup','config-set','console'].includes(action);
const state=z.strictObject({online:z.boolean(),running:z.boolean(),startedAt:z.string(),uptimeSeconds:z.number().int().nonnegative(),players:z.number().int().nonnegative().nullable(),maxPlayers:z.number().int().nonnegative().nullable()});
const text=z.string().max(product.minecraftOutputChars);
const dataSchemas={
  status:state,players:state.extend({names:z.array(z.string().max(80)).max(100).nullable()}),
  start:state,stop:state,restart:state,
  backup:z.strictObject({file:z.string().regex(/^[a-f0-9-]{36}\.tar$/),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
  console:z.strictObject({accepted:z.literal(true),output:text}),
  'config-get':z.strictObject({properties:z.record(configKey,text)}),
  'config-set':z.strictObject({key:configKey,value:configValue,restartRequired:z.literal(true)}),
  logs:z.strictObject({text}),resources:z.strictObject({text}),worlds:z.strictObject({items:z.array(text).max(100)}),addons:z.strictObject({items:z.array(text).max(100)}),
};
export const envelope=z.strictObject({v:z.literal(1),id:z.uuid(),action:actionSchema,ok:z.boolean(),code:z.enum(['ok','busy','rejected','failed','uncertain','offline','unavailable','conflict']),data:z.unknown()});
export type Response=z.infer<typeof envelope>;
export function parseResponse(raw:string,id:string,action:Action):Response{
  const response=envelope.parse(JSON.parse(raw));
  if(response.id!==id || response.action!==action || response.ok!==(response.code==='ok'))throw new Error('Unexpected wrapper response');
  return {...response,data:response.ok?dataSchemas[action].parse(response.data):z.null().parse(response.data)};
}
