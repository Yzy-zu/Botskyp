import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const secret=Buffer.from(process.env.WEBHOOK_SECRET ?? '');
if(secret.length<32)throw new Error('Missing capture secret');
const allowed=new Set([process.env.LAB_CHAT_ID,...(process.env.OWNER_JIDS ?? '').split(',')]);
function clean(v){
  if(Array.isArray(v))return v.map(clean);
  if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!/apikey|secret|token|password|authorization|mediakey|base64|thumbnail|sha256|url|directpath/i.test(k)).map(([k,x])=>[k,clean(x)]));
  return v;
}
http.createServer(async(req,res)=>{
  if(req.url==='/health' && req.method==='GET'){res.writeHead(200);res.end('ok');return;}
  const provided=Buffer.from(req.headers['x-webhook-secret'] ?? '');
  if(req.url!=='/webhook'||req.method!=='POST'||provided.length!==secret.length||!timingSafeEqual(provided,secret)){res.writeHead(401);res.end();return;}
  try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>2_000_000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const event=JSON.parse(Buffer.concat(chunks).toString());
    const data=event.data ?? {};const key=data.key ?? {};
    if(allowed.has(key.remoteJid)||allowed.has(key.remoteJidAlt)||data.id===process.env.LAB_CHAT_ID){
      writeFileSync(`/captures/${Date.now()}-${process.hrtime.bigint()}.json`,JSON.stringify(clean(event),null,2),{mode:0o600});
    }
    const forward=process.env.FORWARD_URL;
    if(forward){
      if(forward!=='http://botsky-app:3000/webhook')throw new Error('Invalid capture forwarding destination');
      const upstream=await fetch(forward,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':secret.toString()},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
      const result=await upstream.text();res.writeHead(upstream.status);res.end(result);
    }else{res.writeHead(200);res.end();}
  }catch(error){res.writeHead(error instanceof SyntaxError?400:502);res.end();}
}).listen(3001,'0.0.0.0');
