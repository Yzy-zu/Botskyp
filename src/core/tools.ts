import { observer } from '../observer/index.js';
import { z } from 'zod';
import pino from 'pino';
import { product } from '../../config/product.js';
import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Msg } from '../wa/types.js';
import type { Actor,Chat,PermissionKey } from './permissions.js';
import { actorFor,moduleEnabled,permitted } from './permissions.js';
import { argumentHash,openSession } from './sessions.js';
import type { Declaration } from './llm.js';
const log=pino({level:'info',redact:['chatId']});
export type ToolResult={ok:true;facts:Record<string,unknown>;reply:string;stylable?:boolean}|{ok:false;kind:'user'|'transient'|'bug';message:string};
export type ToolCtx={inboxTransaction?:true;turnId?:string;actor:Actor;chat:Chat;msg:Msg;db:Db;c:PoolClient;config:Config;now:Date;search:(query:string)=>Promise<string>};
export type CapabilityOperation = { description: string; accepts: string; produces: string };
export type CapabilityMetadata = {
  summary?: string;
  accepts?: string;
  produces: string;
  operations?: Readonly<Record<string, CapabilityOperation>>;
};
export interface Tool<A extends z.ZodType=z.ZodType> {
  name:string;description:string;examples:string[];args:A;permission:PermissionKey;
  risk:'read'|'write'|'destructive';scope:'group'|'private'|'both';modelCallable:boolean;module:string;
  /** Required by the v2 catalog for public tools; optional for isolated legacy test doubles. */
  capability?: CapabilityMetadata;
  run(ctx:ToolCtx,args:z.infer<A>):Promise<ToolResult>;
}
export const ok=(reply:string,facts:Record<string,unknown>={}):ToolResult=>({ok:true,reply,facts});
export const fail=(message:string):ToolResult=>({ok:false,kind:'user',message});
export function defineTool<A extends z.ZodType>(tool:Tool<A>):Tool{
  return {...tool,run:async(ctx,value)=>{
    const args=tool.args.parse(value);
    observer.emit(()=>({eventType:'TOOL_STARTED',stage:'legacy.handler',payload:{toolName:tool.name,args}}));
    try{const outcome=await tool.run(ctx,args);observer.emit(()=>({eventType:tool.risk==='read'?'TOOL_RESULT':'BUSINESS_MUTATION',stage:'legacy.handler.receipt',payload:{toolName:tool.name,args,outcome,transaction:'pending_commit'}}));return outcome;}
    catch(error){observer.emit({eventType:'TOOL_ERROR',stage:'legacy.handler',payload:{toolName:tool.name,error}});throw error;}
  }};
}
export class ToolRegistry {
  private tools=new Map<string,Tool>();
  all():readonly Tool[]{return [...this.tools.values()];}
  register(tool:Tool):void{
    if(this.tools.has(tool.name))throw new Error('Duplicate tool');this.tools.set(tool.name,tool);
  }
  available(ctx:ToolCtx,model=false):Tool[]{
    return [...this.tools.values()].filter(t=>(!model || t.modelCallable) && permitted(ctx.actor,ctx.chat,t.permission)
      && (t.scope==='both' || (t.scope==='group')===ctx.chat.isGroup) && moduleEnabled(ctx.chat,t.module,ctx.config));
  }
  declarations(ctx:ToolCtx):Declaration[]{
    return this.available(ctx,true).map(t=>{
      const schema=z.toJSONSchema(t.args);delete schema.$schema;
      return {name:t.name.replaceAll('.','_'),description:t.description,parametersJsonSchema:schema};
    });
  }
  help(ctx:ToolCtx,topic=''):string{
    const entries=this.available(ctx).filter(t=>!topic || `${t.module} ${t.description}`.toLowerCase().includes(topic.toLowerCase()));
    return entries.map(t=>`${t.name}: ${t.description}\n${t.examples.join(' · ')}`).join('\n\n') || 'No hay herramientas disponibles para ese tema.';
  }
  async execute(ctx:ToolCtx,name:string,args:unknown,source:'model'|'shortcut'|'confirmed'='shortcut'):Promise<ToolResult>{
    const started=performance.now();
    const tool=this.tools.get(name);
    ctx.actor=await actorFor(ctx.c,ctx.msg,ctx.config);
    const current=await ctx.c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[ctx.chat.id]);
    if(current.rows[0])ctx.chat={...ctx.chat,...current.rows[0]};
    const flags=await ctx.c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags');
    const emergency=flags.rows.some(f=>f.key==='emergency' && f.value===true);
    const maintenance=flags.rows.some(f=>f.key==='maintenance' && f.value===true);
    if(emergency && name!=='control.reactivate')return fail('No.');
    if(maintenance && ctx.actor.role!=='owner')return fail('Estoy en mantenimiento.');
    if(!tool || !this.available(ctx,source==='model').includes(tool))return fail('No.');
    const parsed=tool.args.safeParse(args);
    if(!parsed.success)return fail('Faltan datos o los argumentos no son válidos.');
    if(tool.risk==='destructive' && source!=='confirmed'){
      await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'confirm',{action:name,args:parsed.data,hash:argumentHash(name,parsed.data)},['sí','no','cancelar']);
      return ok(`Confirma ${name}: ${JSON.stringify(parsed.data)}\n¿Sí o no? Vence en ${product.confirmMinutes} minutos.`);
    }
    const result=await tool.run(ctx,parsed.data);
    log.info({msgId:ctx.msg.id,chatId:ctx.chat.id,tool:name,ms:Math.round(performance.now()-started),ok:result.ok},'Herramienta ejecutada');
    if(result.ok && tool.risk!=='read')await ctx.c.query('INSERT INTO audit_log(actor_id,chat_id,action) VALUES($1,$2,$3)',[ctx.actor.id,ctx.chat.id,name]);
    return result;
  }
}
