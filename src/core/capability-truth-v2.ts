import type { ToolExposure } from './tool-exposure.js';

const normalized = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function explicitWebRequest(text: string): boolean {
  const value = normalized(text);
  if (/\b(?:videos?|musica|audio)\b/u.test(value) && !/\b(?:web|internet)\b/u.test(value)) return false;
  return /\b(?:busca(?:lo)?|investiga(?:lo)?|checa)\b.{0,45}\b(?:web|internet)\b|\bbusca (?:esto|en la web)\b/u.test(value);
}
/** Hints select available read capabilities, never an execution or mutation. */
export function capabilityTruthTargets(text: string, exposure: ToolExposure): string[] {
  const value = normalized(text), targets: string[] = [];
  if (explicitWebRequest(text)) targets.push('web.search');
  if (exposure.relevantDomains.includes('minecraft')) {
    if (/\b(?:alguien|quien|jugando|jugadores)\b/u.test(value)) targets.push('minecraft.players');
    else if (/\b(?:prendido|activo|estado|anda|encendido|online)\b/u.test(value)) targets.push('minecraft.status','minecraft.resources');
  }
  if (/\b(?:xp|puntos|saldo)\b/u.test(value) && /\b(?:cuant[ao]s?|tengo|traigo|saldo)\b/u.test(value)) targets.push('xp.balance');
  return targets.filter(name => exposure.toolNames.includes(name));
}
export function shouldRetryCapabilityTruth(text: string, answer: string, exposure: ToolExposure): boolean {
  if (!capabilityTruthTargets(text, exposure).length) return false;
  return explicitWebRequest(text) || /\b(?:no (?:puedo|puede|tengo|tiene)|no hay acceso|no (?:esta|tengo).*configur|necesit[ao].*(?:ip|host)|pasame.*(?:ip|host)|dame.*(?:ip|host))\b/u.test(normalized(answer));
}
export function capabilityContextV2(exposure: ToolExposure): string {
  return `Schemas cargados: ${exposure.selectedDomains.join(', ')}. CAPABILITY_MANIFEST es el catálogo completo; core_load_capability carga el dominio que falte. Cumple la utilidad antes del humor.`;
}
