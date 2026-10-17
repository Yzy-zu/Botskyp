import type { Shortcut } from './shortcuts.js';

const commands: Readonly<Record<string, Shortcut>> = {
  ping: { name: 'core.ping', args: {} },
  ayuda: { name: 'core.help', args: {} },
  xp: { name: 'xp.balance', args: {} },
  daily: { name: 'xp.daily', args: {} },
  diario: { name: 'xp.daily', args: {} },
  mc: { name: 'minecraft.status', args: {} },
  'mc status': { name: 'minecraft.status', args: {} },
  'mc players': { name: 'minecraft.players', args: {} },
  pedir: { name: 'games.play', args: { move: 'carta' } },
  carta: { name: 'games.play', args: { move: 'carta' } },
  plantarse: { name: 'games.play', args: { move: 'plantarse' } },
  doblar: { name: 'games.play', args: { move: 'doblar' } },
  entro: { name: 'games.join', args: {} },
  partida: { name: 'games.status', args: {} },
};

/** Exact optional commands only. Unknown, partial and natural requests have no result or effect. */
export function exactFastPathV2(text: string): Shortcut | undefined {
  const match = /^(?:bot|botsky|botsito)\s+(.+)$/iu.exec(text.trim());
  if (!match) return undefined;
  const command = match[1]!.toLocaleLowerCase('es-MX');
  const found = Object.hasOwn(commands, command) ? commands[command] : undefined;
  return found ? { name: found.name, args: { ...found.args } } : undefined;
}
