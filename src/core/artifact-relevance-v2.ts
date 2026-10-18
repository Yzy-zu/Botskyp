/** Operational A_LAST remains available; only explicit references activate old file semantics. */
export function referencesPreviousContentV2(text: string): boolean {
  const explicit=/(?:esa imagen|esa foto|ese archivo|ese pdf|lo anterior|la anterior|l[eé]el[oa]|qu[eé] dice ah[ií]|compr[ií]melo)/iu.test(text);
  if(!explicit && /\b(?:xp|puntos|saldo|minecraft|maicra|maincra|bedrock|mc|server|servidor|web|internet|busca|nota|recordatorio)\b/iu.test(text))return false;
  return /(?<![\p{L}])(?:esa imagen|esa foto|ese archivo|ese pdf|lo anterior|la anterior|leelo|léelo|léela|leela|que dice ahi|qué dice ahí|comprimelo|comprímelo|eso|esto|ese meme|este meme|del meme|que raza|qué raza)(?![\p{L}])/iu.test(text);
}
export function allowsPreviousVisionV2(text: string): boolean {
  return referencesPreviousContentV2(text) || /(?:qué|que|cuánto|cuanto).*(?:ahí|ahi|imagen|foto|cuesta esto)/iu.test(text);
}
