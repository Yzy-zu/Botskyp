import { z } from 'zod';

export const capabilityDomains = [
  'core', 'productivity', 'web', 'economy', 'polls', 'school', 'games',
  'media', 'library', 'moderation', 'minecraft', 'drive', 'admin', 'messaging',
] as const;
export const capabilityDomainSchema = z.enum(capabilityDomains);
export type CapabilityDomain = z.infer<typeof capabilityDomainSchema>;
