import type { Shortcut } from '../../core/shortcuts.js';
export function economyShortcut(text:string):Shortcut|undefined{
  const t=text.toLowerCase().replace(/[.!?]$/u,'');let m:RegExpExecArray|null;
  const names:Record<string,string>={xp:'xp.balance',diario:'xp.daily',entro:'games.join',yoo:'games.claim',airdrop:'games.airdrop',partida:'games.status','partida cancelar':'games.cancel',warns:'moderation.warns','ruleta configuración':'moderation.config','ruleta configuracion':'moderation.config'};
  if(names[t])return {name:names[t],args:{}};
  if(['carta','plantarse','doblar'].includes(t))return {name:'games.play',args:{move:t}};
  if((m=/^blackjack(?:\s+(mesa))?(?:\s+(\d+))?$/u.exec(t)))return {name:'games.blackjack',args:{table:Boolean(m[1]),...(m[2]?{bet:Number(m[2])}:{})}};
  if((m=/^ruleta(?:\s+(\d+))?$/u.exec(t)))return {name:'games.roulette',args:m[1]?{bet:Number(m[1])}:{}};
  if((m=/^hora feliz(?:\s+(off|\d+))?$/u.exec(t)))return {name:'xp.happy',args:m[1]==='off'?{off:true}:m[1]?{minutes:Number(m[1])}:{}};
  if(/^warn\s+@\d+$/u.test(t))return {name:'moderation.change',args:{remove:false}};
  if(/^quita warn\s+@\d+$/u.test(t))return {name:'moderation.change',args:{remove:true}};
  if((m=/^ruleta consecuencias (on|off)$/u.exec(t)))return {name:'moderation.config',args:{enabled:m[1]==='on'}};
  if((m=/^ruleta castigo (\d+)$/u.exec(t)))return {name:'moderation.config',args:{minutes:Number(m[1])}};
  return undefined;
}
