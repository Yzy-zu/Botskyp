import { describe,expect,it } from 'vitest';
import { activated,isPing } from '../src/core/activation.js';
const base={isGroup:true,text:'',mentions:[] as string[]};
describe('deterministic activation',()=>{
  it.each(['Botsky, guarda esta nota','bot transcribe','botsito, cuánto XP','¡BOT!','ese bot está raro'])('activates %s',text=>expect(activated({...base,text},[])).toBe(true));
  it.each(['robot','botella','x_bot','bot2','ábot','boté','pregunta al grupo','2'])('ignores %s',text=>expect(activated({...base,text},[])).toBe(false));
  it('does not search quoted text',()=>expect(activated({...base,quoted:{text:'bot',fromBot:false}},[])).toBe(false));
  it('accepts direct mention, verified quote, private and own session',()=>{
    expect(activated({...base,mentions:['123@lid']},['123@lid'])).toBe(true);
    expect(activated({...base,quoted:{fromBot:true}},[])).toBe(true);
    expect(activated({...base,isGroup:false},[])).toBe(true);
    expect(activated(base,[],true)).toBe(true);
    expect(activated(base,[],false)).toBe(false);
  });
  it.each(['bot ping','Botsky, ping','botsito ping','ping','@123 ping'])('recognizes %s',text=>expect(isPing(text)).toBe(true));
});
