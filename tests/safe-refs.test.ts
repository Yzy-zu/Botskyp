import { expect, it } from 'vitest';
import { SafeRefs, refKinds, type RefResource } from '../src/core/safe-refs.js';
const scope = { chatId: 'chat-a', actorId: 'actor-a' };
const resource = (overrides: Partial<RefResource> = {}): RefResource => ({ kind: 'noteRef', id: 'backend-id', chatId: scope.chatId, label: 'Reunión', access: { visibility: 'personal', ownerId: scope.actorId }, ...overrides });
it.each(refKinds)('isolates %s by chat and personal ownership', kind => {
  const refs = new SafeRefs([resource({ kind })]);
  const ref = refs.list(scope)[0]!.ref;
  expect(refs.resolve(ref, kind, scope)).toMatchObject({ status: 'ok', id: 'backend-id' });
  expect(refs.resolve(ref, kind, { ...scope, chatId: 'chat-b' })).toEqual({ status: 'not_found' });
  expect(refs.resolve(ref, kind, { ...scope, actorId: 'actor-b' })).toEqual({ status: 'not_found' });
  expect(refs.list({ ...scope, actorId: 'actor-b' })).toEqual([]);
});
it('SELF comes exclusively from the authenticated backend scope', () => {
  const refs = new SafeRefs([]);
  expect(refs.resolve('SELF', 'memberRef', scope)).toEqual({ status: 'ok', kind: 'SELF', id: scope.actorId });
  expect(refs.resolve('SELF', 'noteRef', scope).status).toBe('not_found');
});
it('never converts unknown refs, raw JIDs, IDs or wrong ref kinds into arbitrary identifiers', () => {
  const refs = new SafeRefs([resource()]);
  for (const ref of ['backend-id', '100@s.whatsapp.net', 'noteRef_missing', '1', '']) expect(refs.resolve(ref, 'noteRef', scope).status).toBe('not_found');
  expect(refs.resolve(refs.list(scope)[0]!.ref, 'taskRef', scope).status).toBe('not_found');
  expect(new SafeRefs([resource()]).resolve(refs.list(scope)[0]!.ref, 'noteRef', scope).status).toBe('not_found');
});
it('asks for clarification on duplicate names, after applying scope filters', () => {
  const refs = new SafeRefs([resource(), resource({ id: 'other' }), resource({ id: 'alien', chatId: 'chat-b' })]);
  expect(refs.resolveName(' reunión ', 'noteRef', scope)).toEqual({ status: 'needs_clarification' });
  expect(refs.resolveName('inventado', 'noteRef', scope)).toEqual({ status: 'not_found' });
  const isolated = new SafeRefs([resource(), resource({ id: 'alien', chatId: 'chat-b' })]);
  expect(isolated.resolveName('Reunión', 'noteRef', scope)).toMatchObject({ status: 'ok', id: 'backend-id' });
});
it('exposes only opaque references and redacted labels to Gemini', () => {
  const refs = new SafeRefs([resource({ kind: 'memberRef', id: '100@s.whatsapp.net', label: 'Juan 100@s.whatsapp.net' })]);
  expect(JSON.stringify(refs.list(scope))).not.toContain('100@s.whatsapp.net');
  expect(refs.list(scope)[0]).not.toHaveProperty('id');
});
it('personal resource kinds cannot be accidentally declared shared', () => {
  for (const kind of ['artifactRef', 'reminderRef', 'memoryRef', 'driveRef', 'destinationRef', 'opRef'] as const) {
    expect(() => new SafeRefs([resource({ kind, access: { visibility: 'chat' } })])).toThrow('ownership');
  }
  const refs = new SafeRefs([resource({ access: { visibility: 'chat' } })]);
  expect(refs.list({ ...scope, actorId: 'actor-b' })).toHaveLength(1);
});
