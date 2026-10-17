import { checkConnection } from './wa/connection.js';
import Fastify, { LogController } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { configForChat, type Config } from './config.js';
import type { Db } from './db/client.js';
import type { Msg, Transport } from './wa/types.js';
import { receive } from './core/inbox.js';
import { product } from '../config/product.js';
export type Normalize=(input:unknown)=>Msg|null;
export function makeApp(db:Db,config:Config,transport:Transport,normalize:Normalize) {
  const app=Fastify({logger:{level:'info',redact:['req.headers','body','err','error','chatId']},logController:new LogController({disableRequestLogging:true}),bodyLimit:product.maxBodyBytes});
  app.setErrorHandler((error,_request,reply)=>{
    const candidate=typeof error==='object' && error!==null && 'statusCode' in error ? error.statusCode:undefined;
    const status=typeof candidate==='number' && candidate>=400 && candidate<500 ? candidate : 500;
    if(status===500)app.log.error({where:'http'},'Solicitud fallida');
    void reply.code(status).send({error:status===500?'internal':'invalid_request'});
  });
  app.get('/health',async(_req,reply)=>{
    let database=false;let evolution=false;
    try {await db.query('SELECT 1');database=true;} catch {app.log.warn({where:'health.db'},'Base no disponible');}
    try {evolution=await checkConnection(db,config,transport);} catch {app.log.warn({where:'health.evolution'},'Evolution no disponible');}
    const ok=database && evolution;
    return reply.code(ok?200:503).send({ok,database,evolution:config.TRANSPORT==='evolution'?evolution:null,transport:config.TRANSPORT});
  });
  app.post('/webhook',async(req,reply)=>{
    const header=req.headers['x-webhook-secret'];
    const actual=Buffer.from(typeof header==='string'?header:'');const expected=Buffer.from(config.WEBHOOK_SECRET);
    if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) return reply.code(401).send({error:'unauthorized'});
    let msg:Msg|null;
    try {msg=normalize(req.body);} catch {return reply.code(400).send({error:'invalid_event'});}
    if (!msg) return {status:'ignored'};
    const start=performance.now();
    const status=await receive(db,config,msg);
    app.log.info({msgId:msg.id,chatId:msg.chatId,tool:'inbox',routerMode:configForChat(config,msg.chatId).ROUTER_MODE,ms:Math.round(performance.now()-start),status},'Evento recibido');
    return {status};
  });
  return app;
}
