/** Whole-message grammar only. Embedded affirmatives never authorize old arguments. */
export function confirmationInputV2(text: string): 'confirm' | 'cancel' | 'not_consumed' {
  const normalized = sessionTextV2(text);
  if (['sí','si','sip','va','dale','confirmo','hazlo'].includes(normalized)) return 'confirm';
  const cancellation=normalized.replace(/^mejor\s+|\s+mejor$/gu,'');
  if (['nel','no','mejor no','ya no','olvidalo','dejalo','cancelalo','cancela','cancelar','nel cancela','nel mejor cancela eso','cancela eso','mejor cancela eso'].includes(cancellation)) return 'cancel';
  return 'not_consumed';
}

/** Strip only standalone invocation words; mixed replies keep all their other words. */
export function sessionTextV2(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-MX')
    .replace(/(?<![\p{L}\p{N}_])(?:botsky|botsito|bot)(?![\p{L}\p{N}_])/gu, '')
    .replace(/^[\s,;:!?¡¿.]+|[\s,;:!?¡¿.]+$/gu, '').trim();
}
