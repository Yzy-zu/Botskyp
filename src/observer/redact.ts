import { createHash } from 'node:crypto';
const sensitive = /(?:apikey|authorization|password|passwd|secret|cookie|databaseurl|accesskey|privatekey|credential|accesstoken|refreshtoken|idtoken|^token$|^headers$|^env$|^environment$)/i;
const binary = /^(?:base64|bytes|buffer|mediakey|jpegthumbnail|thumbnail|fileencsha256)$/i;
/** Technical logging boundary. Conversation strings are preserved verbatim. */
export function redact(value:unknown, secrets:readonly string[]=[]):unknown {
  const seen=new WeakSet<object>();
  const scrub=(s:string)=>secrets.reduce((text,key)=>key.length>=4?text.split(key).join('[REDACTED]'):text,s)
    .replace(/((?:postgres(?:ql)?|https?|redis):\/\/)[^\s/@]+:[^\s/@]*@/gi,'$1[REDACTED]@')
    .replace(/([?&](?:key|api_?key|authorization|auth|token|access_token|refresh_token|secret|password|signature|x-amz-signature|x-goog-signature)=)[^&#\s"'<>]+/gi,'$1[REDACTED]');
  function visit(v:unknown,key='',parent=''):unknown {
    const normalized=key.replace(/[-_]/g,'');
    if(sensitive.test(normalized))return '[REDACTED]';
    if((binary.test(key) && !(key==='bytes' && typeof v==='number')) || (key==='data' && ['inlineData','inline_data','media'].includes(parent)))return '[BINARY OMITTED]';
    if(v instanceof Error){
      if(seen.has(v))return '[CIRCULAR]';seen.add(v);
      const result={name:v.name,message:scrub(v.message),stack:v.stack?scrub(v.stack):null,...('cause' in v?{cause:visit(v.cause,'cause')}:{}),...Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x,k)]))};
      seen.delete(v);return result;
    }
    if(Buffer.isBuffer(v) || v instanceof Uint8Array)return {omitted:'binary',size:v.byteLength};
    if(v instanceof Date)return v.toISOString();
    if(typeof v==='bigint')return v.toString();
    if(typeof v==='string'){
      if(key==='media')return '[BINARY OMITTED]';
      if(v.startsWith('data:') && v.includes(';base64,'))return '[BINARY OMITTED]';
      if((key==='media' || key==='data') && v.length>1024 && /^[A-Za-z0-9+/=\r\n]+$/.test(v))return '[BINARY OMITTED]';
      return scrub(v);
    }
    if(v && typeof v==='object'){
      if('type' in v && v.type==='Buffer')return '[BINARY OMITTED]';
      if('mimeType' in v && 'data' in v && typeof v.data==='string')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='data'?'[BINARY OMITTED]':visit(x,k)]));
      if(seen.has(v))return '[CIRCULAR]';seen.add(v);
      const result=Array.isArray(v)?v.map(x=>visit(x,'',key)):v instanceof Map?[...v.entries()].map(([k,x])=>({ref:k,value:visit(x)})):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x,k,key)]));
      seen.delete(v);return result;
    }
    return v;
  }
  return visit(value);
}
export function contentHash(value:string):string{return createHash('sha256').update(value).digest('hex');}
