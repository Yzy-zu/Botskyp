import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { product } from '../../../config/product.js';
export function publicIPv4(ip:string):boolean{
  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))return false;
  const [a,b,c]=ip.split('.').map(Number) as [number,number,number,number];
  if(ip.split('.').some(x=>Number(x)>255))return false;
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99) || (b===2 && c===0))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
/** This is the entire source allowlist; no platform extractors, cookies or arbitrary hosts. */
export function acceptedUrl(value:string,api=false):URL{
  if(value.length>2048 || [...value].some(c=>c.charCodeAt(0)<=32 || c==='\\'))throw new Error('invalid_url');
  let url:URL;try{url=new URL(value);}catch{throw new Error('invalid_url');}
  if(url.protocol!=='https:' || url.port || url.username || url.password || url.hash)throw new Error('invalid_url');
  if(api && url.hostname==='commons.wikimedia.org' && url.pathname==='/w/api.php')return url;
  if(url.hostname!=='upload.wikimedia.org' || !/^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+\.(?:ogg|oga|ogv|webm|mp3|wav|mp4|jpg|jpeg|png|webp|gif)$/i.test(url.pathname))throw new Error('source_not_allowed');
  if(/%(?:2f|5c|00)/i.test(url.pathname) || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(url.pathname)))throw new Error('invalid_url');
  // Only Wikimedia's public tracking parameters are accepted; discard them deterministically.
  for(const key of url.searchParams.keys())if(!['utm_source','utm_campaign','utm_content'].includes(key))throw new Error('invalid_url');
  url.search='';return url;
}
export type NetworkDeps={dns:(host:string)=>Promise<string[]>};
export async function checkedAddress(url:URL,dns:NetworkDeps['dns']=resolve4):Promise<string>{
  const addresses=await dns(url.hostname);if(!addresses.length || addresses.some(ip=>!publicIPv4(ip)))throw new Error('unsafe_dns');
  return addresses[0]!;
}
export async function fetchPublic(value:string,options:{api?:boolean;maxBytes?:number;signal?:AbortSignal}={},deps:NetworkDeps={dns:resolve4}):Promise<{bytes:Buffer;mime:string;url:string}>{
  const signal=AbortSignal.any([AbortSignal.timeout(product.mediaDownloadTimeoutMs),...(options.signal?[options.signal]:[])]);
  let valueNow=value;
  for(let redirect=0;redirect<=product.mediaRedirects;redirect++){
    signal.throwIfAborted();const url=acceptedUrl(valueNow,options.api);
    // DNS is checked on every hop. The exact validated IPv4 is pinned to this TLS socket.
    const address=await Promise.race([checkedAddress(url,deps.dns),new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('download_timeout')),{once:true}))]);
    const result=await new Promise<{bytes:Buffer;mime:string;location?:string}>((resolve,reject)=>{
      const req=request(url,{signal,agent:false,family:4,lookup:(_host,_opts,cb)=>cb(null,address,4),headers:{'user-agent':'Botsky/1.0 (bounded Wikimedia client)','accept-encoding':'identity'}},res=>{
        const status=res.statusCode ?? 0;
        if([301,302,303,307,308].includes(status)){
          const location=res.headers.location;res.destroy();if(!location)return reject(new Error('invalid_redirect'));
          resolve({bytes:Buffer.alloc(0),mime:'',location:new URL(location,url).href});return;
        }
        if(status!==200){res.destroy();reject(new Error(`source_http_${status}`));return;}
        const max=options.maxBytes ?? product.mediaInputBytes;
        const length=res.headers['content-length'];const declared=length===undefined?undefined:Number(length);
        if((declared!==undefined && (!Number.isSafeInteger(declared) || declared<1 || declared>max)) || (res.headers['content-encoding'] && res.headers['content-encoding']!=='identity')){res.destroy();reject(new Error('size_or_encoding_limit'));return;}
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>max){reject(new Error('size_limit'));res.destroy();return;}chunks.push(chunk);});
        res.on('end',()=>{if(!res.complete || !size || (declared!==undefined && size!==declared)){reject(new Error('truncated_download'));return;}resolve({bytes:Buffer.concat(chunks),mime:(res.headers['content-type'] ?? '').split(';')[0]!.toLowerCase()});});
        res.on('error',()=>reject(new Error('download_incomplete')));
        res.on('aborted',()=>reject(new Error('truncated_download')));
      });req.on('error',()=>reject(new Error(signal.aborted?'download_timeout':'download_network')));req.end();
    });
    if(result.location){valueNow=result.location;continue;}
    return {...result,url:url.href};
  }
  throw new Error('redirect_limit');
}
