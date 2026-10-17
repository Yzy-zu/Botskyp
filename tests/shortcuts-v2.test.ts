import { expect, it } from 'vitest';
import { exactFastPathV2 } from '../src/core/shortcuts-v2.js';
import { shortcut } from '../src/core/shortcuts.js';

it.each([
  ['bot xp','xp.balance',{}], ['bot daily','xp.daily',{}], ['bot mc','minecraft.status',{}],
  ['bot pedir','games.play',{move:'carta'}], ['bot plantarse','games.play',{move:'plantarse'}],
])('matches the complete command %s only', (text, name, args) => {
  expect(exactFastPathV2(text)).toEqual({ name, args });
});
it.each([
  'minecraft está prendido?', 'busca en las notas cálculo', 'drive está activo?',
  'enviar archivos por correo es seguro?', 'yo voto por tacos', 'horario de mañana',
  'bot minecraft está prendido?', 'botsky busca en nuestras notas cálculo',
  'bot mc reinicia quizá', 'bot xp de ayer', 'bot xp?', 'bot pedir cinco',
  'botsky guarda en tu memoria que me gustan los tacos', 'guarda en tu memoria...',
  'bot acuérdate de que me gustan los tacos', 'bot recuerda que me gustan los tacos',
  'bot anota en el grupo que mañana comemos', 'bot crea una nota de tacos',
  'bot guarda una nota de tacos', 'bot nota', 'bot drive', 'bot enviar', 'xp', 'bot constructor', 'bot toString',
])('lets ambiguous, partial and natural text pass: %s', text => {
  expect(exactFastPathV2(text)).toBeUndefined();
});
it('does not change the historical v1 shortcut, including its memory/notes ambiguity', () => {
  const text = 'botsky guarda en tu memoria que me gustan los tacos';
  expect(shortcut(text, 'America/Mexico_City', new Date())).toMatchObject({ name: 'notes.create' });
  expect(exactFastPathV2(text)).toBeUndefined();
});
it('does not let callers mutate subsequent fast-path decisions', () => {
  const call = exactFastPathV2('bot pedir')!; call.args['move'] = 'invalid';
  expect(exactFastPathV2('bot pedir')?.args).toEqual({ move: 'carta' });
});
