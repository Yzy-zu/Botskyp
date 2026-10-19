import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const refKinds = ['memberRef', 'artifactRef', 'noteRef', 'reminderRef', 'memoryRef', 'pollRef', 'taskRef', 'subjectRef', 'driveRef', 'destinationRef', 'opRef', 'videoRef'] as const;
export type RefKind = typeof refKinds[number];
export type SafeRef = 'SELF' | `${RefKind}_${string}`;
export type RefScope = { chatId: string; actorId: string };
const resourceSchema = z.strictObject({
  kind: z.enum(refKinds), id: z.string().min(1), chatId: z.string().min(1),
  label: z.string().min(1),
  access: z.discriminatedUnion('visibility', [
    z.strictObject({ visibility: z.literal('chat') }),
    z.strictObject({ visibility: z.literal('personal'), ownerId: z.string().min(1) }),
  ]),
});
/** Only authenticated backend loaders may supply these records; never pass model arguments here. */
export type RefResource = z.infer<typeof resourceSchema>;
export type RefResolution = { status: 'ok'; id: string; kind: RefKind | 'SELF' }
  | { status: 'not_found' | 'needs_clarification' };
const personalKinds = new Set<RefKind>(['artifactRef', 'reminderRef', 'memoryRef', 'driveRef', 'destinationRef', 'opRef', 'videoRef']);
function visible(resource: RefResource, scope: RefScope): boolean {
  return resource.chatId === scope.chatId &&
    (resource.access.visibility === 'personal' ? resource.access.ownerId === scope.actorId : !personalKinds.has(resource.kind));
}
function normalized(label: string): string { return label.normalize('NFKC').trim().toLocaleLowerCase('es-MX'); }

/** Opaque, scoped snapshot. Model-facing entries contain neither backend IDs nor JIDs. */
export class SafeRefs {
  private readonly resources = new Map<SafeRef, RefResource>();
  constructor(resources: readonly RefResource[]) {
    for (const input of resources) {
      const resource = resourceSchema.parse(input);
      if (personalKinds.has(resource.kind) && resource.access.visibility !== 'personal') {
        throw new Error('Personal references require ownership');
      }
      this.resources.set(`${resource.kind}_${randomBytes(12).toString('hex')}`, resource);
    }
  }
  /** Merge another authenticated snapshot while retaining references already sent this turn. */
  include(snapshot: SafeRefs): void {
    for (const [ref, resource] of snapshot.resources) this.resources.set(ref, resource);
  }
  list(scope: RefScope): { ref: SafeRef; label: string; kind: RefKind }[] {
    return [...this.resources].filter(([, r]) => visible(r, scope)).map(([ref, r]) => ({
      ref, kind: r.kind, label: r.label.replace(/\b\d+@(?:s\.whatsapp\.net|g\.us|lid)\b/gu, '[identidad]'),
    }));
  }
  resolve(ref: string, kind: RefKind | 'SELF', scope: RefScope): RefResolution {
    if (ref === 'SELF') return kind === 'SELF' || kind === 'memberRef'
      ? { status: 'ok', id: scope.actorId, kind: 'SELF' } : { status: 'not_found' };
    const r = this.resources.get(ref as SafeRef);
    if (!r || r.kind !== kind || !visible(r, scope)) return { status: 'not_found' };
    return { status: 'ok', id: r.id, kind: r.kind };
  }
  resolveName(name: string, kind: RefKind, scope: RefScope): RefResolution {
    const matches = [...this.resources.values()].filter(r => r.kind === kind && visible(r, scope) && normalized(r.label) === normalized(name));
    const ids = new Set(matches.map(r => r.id));
    if (ids.size > 1) return { status: 'needs_clarification' };
    const match = matches[0];
    return match ? { status: 'ok', id: match.id, kind } : { status: 'not_found' };
  }
}
