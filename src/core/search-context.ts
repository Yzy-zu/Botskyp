import { callWord } from './activation.js';

export type SearchRequest={query:string;contextual:boolean};

/** Recognize complete commands separately from searches that require an antecedent. */
export function searchRequest(text:string):SearchRequest|undefined{
  const input=text.trim().replace(/^(?:@\d+\s*)+/u,'')
    .replace(new RegExp(`^(?:oye\\s+)?${callWord.source}[\\s,:;!]*`,'iu'),'');
  const match=/^(?:pero\s+)?(?:busca en (?:la )?web|busca)\s+(.+)$/isu.exec(input);
  if(!match)return undefined;
  const query=match[1]!.replace(new RegExp(`[\\s,;]+${callWord.source}[.!?\\s]*$`,'iu'),'').trim();
  if(!query)return undefined;
  const reference=/(?:\b(?:eso|ello)\b|\b(?:esa|ese|esta|este|aquella|aquel|misma|mismo)\s+(?:serie|anime|temporada|personaje|tema|pel[ií]cula|foto|imagen)\b|\b(?:de|en)\s+(?:la|el)\s+(?:foto|imagen|anterior)\b)/iu.test(query);
  const missingSubject=/^(?:(?:cu[aá]ndo|para cu[aá]ndo)\s+(?:sale|saldr[aá]|se estrena|estrenan)\s+)?(?:la\s+)?(?:nueva|pr[oó]xima|siguiente)\s+temporada[.!?\s]*$/iu.test(query);
  return {query,contextual:reference || missingSubject};
}

export function previousSearchRequest(history:readonly {role:string;text:string}[]):string|undefined{
  for(const message of [...history].reverse()){
    if(message.role!=='user')continue;
    const previous=searchRequest(message.text);
    if(previous)return previous.query;
  }
  return undefined;
}

/** Do not let an unverified model season number narrow a request for the upcoming season. */
export function preserveSearchIntent(query:string,request:string,previous?:string):string{
  const goal=`${request} ${previous ?? ''}`;
  if(!/\b(?:nueva|pr[oó]xima|siguiente)\s+temporada\b/iu.test(goal) || /\b(?:temporada|season)\s*#?\s*\d/iu.test(goal))return query;
  return query.replace(/\btemporada\s*#?\s*\d+\b/giu,'nueva temporada').replace(/\bseason\s*#?\s*\d+\b/giu,'upcoming season');
}
