/** Explicit live regression: isolated DB, local reference image, no WhatsApp outbox. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import setup from './setup.js';
import { createDb,transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { route,rememberContext } from '../src/core/router.js';
import { receive } from '../src/core/inbox.js';
import { searxSearch } from '../src/modules/web/index.js';
import type { Msg } from '../src/wa/types.js';

const searchOnly=process.argv[2]==='--search-only';
const imagePath=searchOnly?undefined:process.argv[2];
assert(searchOnly || imagePath,'Usage: npm run eval:phase1 -- /private/path/to/the/reviewed-pug-meme.jpg | --search-only');
const image=imagePath?readFileSync(imagePath).toString('base64'):'';
const cleanup=await setup();
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
const db=createDb(url),realFetch=globalThis.fetch;
const evidence:{request:string;reply:string|undefined;searches:string[];ms:number}[]=[];
const providerStatuses:number[]=[];
try{
  await migrate(db);
  const searchIp=execFileSync('docker',['inspect','botsky-searxng-1','--format','{{(index .NetworkSettings.Networks "botsky_internal").IPAddress}}'],{encoding:'utf8'}).trim();
  const config=readConfig({ROUTER_MODE:'v1',...process.env,DATABASE_URL:url,TRANSPORT:'mock',EVOLUTION_URL:'http://mock',OWNER_JIDS:'100@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',SEARXNG_URL:`http://${searchIp}:8080`});
  assert.equal(config.WEB_SEARCH_PROVIDER,'searxng');
  const actor={id:'100@s.whatsapp.net',role:'owner' as const};
  const chat={id:'300@g.us',isGroup:true,enabled:true,settings:{}};
  await db.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true)',[chat.id]);
  await db.query('INSERT INTO users(id) VALUES($1)',[actor.id]);
  const photoId=randomUUID();
  // Only media delivery is local; Gemini and SearXNG use their real adapters.
  globalThis.fetch=async (input,init)=>{
    const endpoint=String(input);
    if(endpoint.startsWith(config.EVOLUTION_URL)){
      const body=JSON.parse(String(init?.body)) as {message:{key:{id:string;remoteJid:string}}};
      assert.equal(body.message.key.id,photoId);assert.equal(body.message.key.remoteJid,chat.id);
      return Response.json({mimetype:'image/jpeg',base64:image});
    }
    const response=await realFetch(input,init);
    if(endpoint.startsWith('https://generativelanguage.googleapis.com/'))providerStatuses.push(response.status);
    return response;
  };
  const ask=async(text:string,photo=false)=>{
    const msg:Msg={id:photo?photoId:randomUUID(),chatId:chat.id,senderId:actor.id,isGroup:true,ts:new Date(),text,fromMe:false,mentions:[],attachments:photo?[{kind:'image',ref:`${photoId}:image`,mime:'image/jpeg'}]:[]};
    if(photo)await receive(db,config,msg);
    const searches:string[]=[],start=performance.now();
    const reply=await transaction(db,async c=>{
      const ctx={actor,chat,msg,db,c,config,now:new Date(),search:async(query:string)=>{searches.push(query);return searxSearch(config,query);}};
      const result=await route(ctx);if(result)await rememberContext(ctx,result);return result;
    });
    evidence.push({request:text,reply,searches,ms:Math.round(performance.now()-start)});
    return reply ?? '';
  };
  if(!searchOnly){
    const description=await ask('oye botsky, quien esta en la foto',true);
    assert.match(description.split(/[.!?]\s/u)[0] ?? '',/perr|pug|carlino/iu,'Describe the actual subject before the joke');
    const breed=await ask('que raza será bot?');
    assert.match(breed,/pug|carlino/iu,'Give the plausible identification for this reviewed image');
    assert.match(breed,/parece|podr[ií]a|probablemente|tentativ[ao]|imposible (?:confirmar|asegurar|determinar)|no (?:puedo|se puede) (?:confirmar|asegurar|determinar)|no es (?:segur|posible)/iu,'Express visual uncertainty');
    assert.doesNotMatch(breed,/\b(?:es|se trata de)\s+(?:un\s+)?(?:pug|carlino)\s+(?:puro|de raza pura)\b|(?:sin duda|definitivamente)\s+(?:es|un)\b/iu,'Do not invent certainty');
    const first=breed.split(/[.!?]\s/u)[0] ?? '';
    assert.match(first,/pug|carlino|no (?:puedo|se puede) (?:confirmar|asegurar|determinar)/iu,'Substance must precede personality');
    const math=await ask('bot cuanto es 17 por 23?');
    assert.match(math.split(/[.!?]\s/u)[0] ?? '',/391/u,'Useful content must come first outside vision too');
  }
  // Explicitly seed a known earlier identification; this tests search continuity,
  // not the model accuracy of identifying an anime character from a separate photo.
  await db.query('DELETE FROM context_msgs');
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES($1,$2,'user','oye botsky quien esta en la foto'),($1,$2,'bot','Es Emilia de Re:Zero.')",[chat.id,actor.id]);
  for(const request of ['busca cuando sale la nueva temporada botsky','pero busca de la de la foto botsky']){
    const reply=await ask(request),last=evidence.at(-1)!;
    assert.equal(last.searches.length,1,'Actually use SearXNG');
    assert.match(last.searches[0]!,/re[\W_]*zero/iu,'Preserve the identified subject');
    assert.match(last.searches[0]!,/temporada|season/iu,'Preserve the season goal');
    assert.match(last.searches[0]!,/estreno|sale|release|air|premiere/iu,'Preserve the release-date intention');
    assert.doesNotMatch(last.searches[0]!,/cosplay|disfra|(?:temporada|season)\s*\d/iu,'Do not replace the goal or invent a season number');
    assert.match(reply,/https?:\/\//u,'Return actual source links');
    assert.match(reply,/re[\W_]*zero/iu,'Returned sources must retain the series topic');
  }
  assert.equal((await db.query<{count:number}>('SELECT count(*)::int AS count FROM outbox')).rows[0]?.count,0);
  const usage=(await db.query('SELECT status,purpose,input_tokens,output_tokens FROM llm_usage ORDER BY id')).rows;
  writeFileSync('.local/phase1-vision-search-eval.json',JSON.stringify({at:new Date().toISOString(),passed:true,searchOnly,evidence,usage,providerStatuses,whatsAppMessages:0}),{mode:0o600});
  console.log(JSON.stringify({passed:true,searchOnly,evidence:evidence.map(row=>({...row,reply:row.reply?.slice(0,260)})),usage,whatsAppMessages:0}));
}catch(error){
  const usage=(await db.query('SELECT status,purpose,input_tokens,output_tokens FROM llm_usage ORDER BY id')).rows;
  writeFileSync('.local/phase1-vision-search-eval.json',JSON.stringify({at:new Date().toISOString(),passed:false,evidence,usage,providerStatuses}),{mode:0o600});
  console.error(error instanceof assert.AssertionError?error.message:'Live evaluation failed; private evidence saved, no WhatsApp messages sent.');
  process.exitCode=1;
}finally{
  globalThis.fetch=realFetch;
  await db.end();await cleanup();
}
