/** Whole-message grammar only. Embedded affirmatives never authorize old arguments. */
export function confirmationInputV2(text: string): 'confirm' | 'cancel' | 'not_consumed' {
  const normalized = text.normalize('NFKC').trim().toLocaleLowerCase('es-MX').replace(/[.!?¡¿]+$/u, '').trim();
  if (['sí','si','sip','va','dale','confirmo','hazlo'].includes(normalized)) return 'confirm';
  if (['nel','no','mejor no','cancela','cancelar','nel cancela','nel mejor cancela eso','cancela eso','mejor cancela eso'].includes(normalized)) return 'cancel';
  return 'not_consumed';
}
