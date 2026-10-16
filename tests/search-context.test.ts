import { it,expect } from 'vitest';
import { searchRequest,previousSearchRequest,preserveSearchIntent } from '../src/core/search-context.js';
import { shortcut } from '../src/core/shortcuts.js';

it.each([
  ['busca cuando sale la nueva temporada botsky','cuando sale la nueva temporada'],
  ['pero busca de la de la foto botsky','de la de la foto'],
  ['bot busca cuándo sale esa serie','cuándo sale esa serie'],
])('keeps contextual search out of deterministic shortcuts: %s',(text,query)=>{
  expect(searchRequest(text)).toEqual({query,contextual:true});
  expect(shortcut(text,'UTC',new Date())).toBeUndefined();
});
it.each([
  ['bot busca en la web sitio oficial PostgreSQL','sitio oficial PostgreSQL'],
  ['busca fecha nueva temporada de Re:Zero botsky','fecha nueva temporada de Re:Zero'],
  ['oye botsky, busca noticias de México de hoy','noticias de México de hoy'],
])('retains complete searches as deterministic commands: %s',(text,query)=>{
  expect(shortcut(text,'UTC',new Date())).toEqual({name:'web.search',args:{query}});
});
it('extracts the previous user search goal without treating tool results as a request',()=>{
  expect(previousSearchRequest([{role:'user',text:'busca cuando sale la nueva temporada botsky'},{role:'bot',text:'busca disfraces'}])).toBe('cuando sale la nueva temporada');
  expect(shortcut('bot nota guarda hablar con botsky','UTC',new Date())).toEqual({name:'notes.create',args:{body:'hablar con botsky'}});
});
it('does not allow an invented season number to narrow the upcoming-season goal',()=>{
  expect(preserveSearchIntent('Re Zero temporada 3 fecha de estreno','de la de la foto','cuando sale la nueva temporada')).toBe('Re Zero nueva temporada fecha de estreno');
  expect(preserveSearchIntent('Re Zero season 3 release','nueva temporada')).toBe('Re Zero upcoming season release');
  expect(preserveSearchIntent('Re Zero temporada 3 fecha','nueva temporada 3')).toBe('Re Zero temporada 3 fecha');
  expect(preserveSearchIntent('Re Zero temporada 3 fecha','temporada 3')).toBe('Re Zero temporada 3 fecha');
  expect(preserveSearchIntent('libro temporada 3','precio del libro')).toBe('libro temporada 3');
});
