/** Technical non-empty check only. Confirmations and cancellations are interpreted by Gemini via core.session_confirm and core.session_cancel. */
export function hasNonEmptyTurnTextV2(text: string): boolean {
  return text.trim().length > 0;
}
