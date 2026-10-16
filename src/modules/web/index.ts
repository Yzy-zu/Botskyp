import { z } from 'zod';
import { defineTool,ok,type Tool } from '../../core/tools.js';
import type { Config } from '../../config.js';
import { product } from '../../../config/product.js';
export async function searxSearch(config:Config,query:string,http:typeof fetch=fetch):Promise<string>{
  const url=new URL('/search',config.SEARXNG_URL);url.searchParams.set('q',query);url.searchParams.set('format','json');url.searchParams.set('language','es');
  const response=await http(url,{signal:AbortSignal.timeout(product.requestTimeoutMs),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw new Error('Search unavailable');}
  const data=z.object({results:z.array(z.object({title:z.string(),url:z.url(),content:z.string().optional()}))}).parse(await response.json());
  const results=data.results.filter(r=>/^https?:/.test(r.url)).slice(0,product.searchResults);
  if(!results.length)throw new Error('No search results');
  return results.map(r=>`${r.title}\n${r.content?.slice(0,product.searchSnippetChars) ?? ''}\n${r.url}`).join('\n\n');
}
export const webTools:Tool[]=[defineTool({name:'web.search',module:'web',permission:'chat.use',scope:'both',modelCallable:true,risk:'read',description:'Buscar información actual en la web y devolver fuentes verificables.',examples:['bot busca en la web noticias de México'],args:z.strictObject({query:z.string().trim().min(1).max(product.searchQueryChars)}),
  async run(ctx,args){return ok(await ctx.search(args.query));}})];
