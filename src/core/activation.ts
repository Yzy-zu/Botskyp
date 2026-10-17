export const callWord = /(?<![\p{L}\p{N}_])(botsky|botsito|bot)(?![\p{L}\p{N}_])/iu;
export function activated(msg: {isGroup:boolean; text:string; mentions:string[]; quoted?:{fromBot:boolean;text?:string|undefined}|undefined}, botIds: readonly string[], ownSession = false): boolean {
  return !msg.isGroup || callWord.test(msg.text) || msg.mentions.some(id => botIds.includes(id)) || msg.quoted?.fromBot === true || ownSession;
}
export function isPing(text: string): boolean {
  return /^(?:(?:botsky|botsito|bot)[\s,:;!]+)?ping[.!?]?$/iu.test(text.trim().replace(/@\d+\s*/g, ''));
}
export function enableCommand(text: string): boolean { return /^bot\s+habilita\s+(?:aqu[ií]|este\s+chat)$/iu.test(text.trim()); }
