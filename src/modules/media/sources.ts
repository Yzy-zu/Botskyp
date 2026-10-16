import { z } from 'zod';
import { product } from '../../../config/product.js';
import { acceptedUrl,fetchPublic } from './network.js';
export const choiceSchema=z.strictObject({title:z.string().max(300),url:z.string().max(2048),mime:z.string(),size:z.number().int().positive(),page:z.string().max(1000)});
export type Choice=z.infer<typeof choiceSchema>;
const responseSchema=z.object({query:z.object({pages:z.record(z.string(),z.object({title:z.string(),index:z.number().optional(),imageinfo:z.array(z.object({url:z.string(),mime:z.string(),size:z.number(),duration:z.number().optional(),descriptionurl:z.string()})).optional()}))}).optional()});
export async function searchMedia(query:string,type:'audio'|'video'):Promise<Choice[]>{
  const url=new URL('https://commons.wikimedia.org/w/api.php');
  url.search=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:`filetype:${type} ${query}`,gsrnamespace:'6',gsrlimit:String(product.searchResults),prop:'imageinfo',iiprop:'url|mime|size'}).toString();
  const {bytes}=await fetchPublic(url.href,{api:true,maxBytes:product.mediaApiBytes});
  const data=responseSchema.parse(JSON.parse(bytes.toString('utf8')));
  return Object.values(data.query?.pages ?? {}).sort((a,b)=>(a.index ?? 0)-(b.index ?? 0)).flatMap(p=>{
    const info=p.imageinfo?.[0];if(!info || info.size>product.mediaInputBytes || (info.duration ?? 0)>product.mediaDurationSeconds)return [];
    try{return [choiceSchema.parse({title:p.title.slice(0,300),url:acceptedUrl(info.url).href,mime:info.mime,size:info.size,page:info.descriptionurl})];}catch{return [];}
  });
}
