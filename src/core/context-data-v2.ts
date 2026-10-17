/** Redact transport/backend identifiers, not the meaning or imperative content of user data. */
export function contextData(text: string): string {
  return text.replace(/\b[\d-]+@(?:s\.whatsapp\.net|g\.us|lid)\b/giu, '[identidad]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '[identificador]')
    .replace(/(?:[A-Za-z]:\\|(?<![:/\w])\/(?:[A-Za-z0-9._~-]+\/)+)[^\s"<>]*/gu, '[ruta]');
}
