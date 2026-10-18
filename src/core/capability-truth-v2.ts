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
  const hints = ['El Registry define las capacidades reales. Cumple la utilidad solicitada antes del humor.'];
  if (exposure.availableDomains.length) {
    const summary = exposure.availableDomains.map(d => `${d}: ${exposure.capabilityDirectory[d] ?? d}`).join(' | ');
    hints.push(`Directorio de dominios disponibles en este chat (usa core_load_capability({domain}) si necesitas una herramienta de un dominio no expuesto): ${summary}`);
  }
  if (exposure.availableDomains.includes('minecraft') || exposure.toolNames.includes('minecraft.status')) {
    hints.push('Botsky tiene un servidor Minecraft Bedrock configurado (dominio minecraft). Si el usuario pregunta por el servidor con cualquier variante o typo, usa las funciones minecraft_* expuestas o carga el dominio minecraft con core_load_capability. No pidas host/IP salvo que la herramienta reporte configuración faltante.');
  }
  if (exposure.availableDomains.includes('web') || exposure.toolNames.includes('web.search')) {
    hints.push('Si el usuario pide explícitamente buscar en web/internet, usa web_search antes de responder; una broma no sustituye la búsqueda. No infieras datos personales del usuario a partir de páginas sobre otras personas: sin evidencia suficiente, dilo. Incluye enlaces de las fuentes devueltas. Buscar videos o música corresponde a multimedia.');
  }
  return hints.join('\n');
}
