import { z } from 'zod';
import { product } from '../../config/product.js';
import type { Actor } from './permissions.js';
import { capabilityDomains, capabilityDomainSchema, type CapabilityDomain } from './capability-domain.js';
import { alwaysOnBusinessTools, modelDeclaration, type ToolMetadataV2 } from './tool-registry-v2.js';
import type { Declaration } from './llm.js';

export const MAX_TOOLS_PER_TURN = product.maxToolsPerTurn;
export const MAX_CAPABILITY_EXPANSIONS_PER_TURN = product.maxCapabilityExpansionsPerTurn;
export type ArtifactContext = { kind: string; mime?: string };
export interface ToolExposureInput {
  text: string;
  quotedText?: string;
  actorRole: Actor['role'];
  chatType: 'group' | 'private';
  enabledModules: readonly string[];
  currentAttachment?: ArtifactContext;
  currentArtifact?: ArtifactContext;
  activeSession?: { domain: CapabilityDomain };
  openPoll?: boolean;
  activeGame?: boolean;
  openCooperacha?: boolean;
  recentArtifactContext?: readonly ArtifactContext[];
}
export interface ToolExposure {
  readonly toolNames: readonly string[];
  readonly schemas: readonly Declaration[];
  readonly selectedDomains: readonly CapabilityDomain[];
  readonly relevantDomains: readonly CapabilityDomain[];
  readonly semanticHints: readonly ('memory' | 'shared_notes')[];
  readonly approximateSchemaBytes: number;
}
const signals: Readonly<Partial<Record<CapabilityDomain, RegExp>>> = {
  productivity: /\b(?:memoria|recuerda|recuerdas|recuerdos|acuerdate|memoriza|nota|notas|anota|recordatorio|recuerdame)\b/gu,
  web: /\b(?:web|internet|google|noticias)\b/gu,
  economy: /\b(?:xp|daily|diario|saldo|nivel|hora feliz)\b/gu,
  polls: /\b(?:voto|vota|votar|encuesta|encuestas|sondeo)\b/gu,
  school: /\b(?:tarea|tareas|horario|materia|materias|escuela|clase|clases)\b/gu,
  games: /\b(?:blackjack|ruleta|juego|juegos|partida|plantarse|doblar|airdrop)\b/gu,
  media: /\b(?:pdf|docx|convierte|convertir|comprimelo|comprimir|sticker|audio|video|ocr|transcribe)\b/gu,
  library: /\b(?:biblioteca|pack|packs|cooperacha|lluvia)\b/gu,
  moderation: /\b(?:warn|warns|moderacion|castigo)\b/gu,
  minecraft: /\b(?:minecraft|bedrock|mc)\b/gu,
  drive: /\b(?:drive)\b/gu,
  admin: /\b(?:modulos|mantenimiento|cuota|diagnostico|emergencia)\b/gu,
  messaging: /\b(?:nuclear|difusion|destinatarios|correo|mensajes)\b/gu,
};
function normalize(text: string): string { return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-MX'); }
function lexicalDomains(text: string, quoted: string): CapabilityDomain[] {
  return capabilityDomains.map((domain, order) => {
    const pattern = signals[domain];
    return { domain, order, score: pattern ? [...text.matchAll(pattern)].length * 2 + [...quoted.matchAll(pattern)].length : 0 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).map(item => item.domain);
}
function relevantDomains(input: ToolExposureInput): CapabilityDomain[] {
  const domains: CapabilityDomain[] = ['core'];
  if (input.activeSession) domains.push(input.activeSession.domain);
  if (input.currentAttachment || input.currentArtifact || input.recentArtifactContext?.length) domains.push('media');
  if (input.activeGame) domains.push('games');
  if (input.openPoll) domains.push('polls');
  if (input.openCooperacha) domains.push('library');
  const lexical = lexicalDomains(normalize(input.text), normalize(input.quotedText ?? ''));
  domains.push(...lexical.filter(domain => domain !== 'admin'));
  if (lexical.includes('admin')) domains.push('admin');
  return [...new Set(domains)];
}
function eligible(tool: ToolMetadataV2, input: ToolExposureInput): boolean {
  return tool.llmVisible && tool.exposure !== 'internal'
    && input.enabledModules.includes(tool.requiredModule)
    && (tool.scope === 'both' || tool.scope === input.chatType)
    // Token optimization only. Other restricted actions remain understandable to members.
    && (tool.domain !== 'admin' || input.actorRole === 'owner');
}
const preferred: readonly string[] = ['minecraft.status','minecraft.players','minecraft.restart','games.play','games.status','polls.vote','polls.results','cooperacha.status','cooperacha.contribute','bulk.nuclear','media.process','school.schedule','school.tasks','school.task_create'];
function domainTools(catalog: readonly ToolMetadataV2[], domain: CapabilityDomain, input: ToolExposureInput): ToolMetadataV2[] {
  const rank = (name: string) => { const index = preferred.indexOf(name); return index < 0 ? preferred.length : index; };
  return catalog.filter(tool => tool.domain === domain && eligible(tool, input))
    .sort((a, b) => rank(a.name) - rank(b.name));
}
export const loadCapabilityArgsSchema = z.strictObject({ domain: capabilityDomainSchema });
export const loadCapabilityMetaTool = Object.freeze({
  name: 'core.load_capability', domain: 'core', llmVisible: true, exposure: 'always',
  descriptionForModel: 'Pedir al backend schemas de un dominio relevante para este turno. Una expansión máxima; sin ejecutar acciones. Visibilidad nunca concede permiso.',
  modelArgsSchema: loadCapabilityArgsSchema,
});
function metaDeclaration(): Declaration {
  const schema = z.toJSONSchema(loadCapabilityArgsSchema); delete schema.$schema;
  return { name: 'core_load_capability', description: loadCapabilityMetaTool.descriptionForModel, parametersJsonSchema: schema };
}
function snapshot(tools: readonly ToolMetadataV2[], relevant: readonly CapabilityDomain[], input: ToolExposureInput): ToolExposure {
  const schemas = [...tools.map(modelDeclaration), metaDeclaration()];
  const text = normalize(input.text);
  const semanticHints: ('memory' | 'shared_notes')[] = [];
  if (/\b(?:memoria|acuerdate|recuerda que|memoriza)\b/u.test(text)) semanticHints.push('memory');
  else if (/\b(?:anota en el grupo|crea una nota|guarda una nota)\b/u.test(text)) semanticHints.push('shared_notes');
  return Object.freeze({
    toolNames: Object.freeze([...tools.map(tool => tool.name), loadCapabilityMetaTool.name]),
    schemas: Object.freeze(schemas), selectedDomains: Object.freeze([...new Set<CapabilityDomain>(['core', ...tools.map(tool => tool.domain)])]),
    relevantDomains: Object.freeze([...relevant]), semanticHints: Object.freeze(semanticHints),
    approximateSchemaBytes: Buffer.byteLength(JSON.stringify(schemas), 'utf8'),
  });
}
function baseTools(catalog: readonly ToolMetadataV2[], input: ToolExposureInput): ToolMetadataV2[] {
  return alwaysOnBusinessTools.flatMap(name => catalog.filter(tool => tool.name === name && eligible(tool, input)));
}
export function selectToolExposure(catalog: readonly ToolMetadataV2[], input: ToolExposureInput): ToolExposure {
  const tools = baseTools(catalog, input);
  const relevant = relevantDomains(input);
  // Preserve one representative per relevant non-admin domain before filling a large catalog.
  // This prevents a school session from displacing an attached document's media capability.
  for (const domain of relevant.filter(domain => domain !== 'core' && domain !== 'admin')) {
    const representative = domainTools(catalog, domain, input).find(tool => !tools.includes(tool));
    if (representative && tools.length < MAX_TOOLS_PER_TURN - 1) tools.push(representative);
  }
  for (const domain of relevant) {
    // Core contributes only the definitive always-on set. Admin is last, including role fallback.
    if (domain === 'core') continue;
    for (const tool of domainTools(catalog, domain, input)) {
      if (tools.length >= MAX_TOOLS_PER_TURN - 1) break;
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return snapshot(tools, relevant, input);
}
export type CapabilityExpansion = { status: 'ok'; exposure: ToolExposure }
  | { status: 'invalid_domain' | 'not_relevant_or_allowed' | 'expansion_limit' | 'capacity'; exposure: ToolExposure };

/** Backend-owned lifetime: instantiate once per turn, never from model state. No business executor. */
export class ToolExposureTurn {
  private expansions = 0;
  private current: ToolExposure;
  private readonly input: ToolExposureInput;
  constructor(private readonly catalog: readonly ToolMetadataV2[], input: ToolExposureInput) {
    this.input = structuredClone(input);
    this.current = selectToolExposure(catalog, this.input);
  }
  get exposure(): ToolExposure { return this.current; }
  loadCapability(args: unknown): CapabilityExpansion {
    const parsed = loadCapabilityArgsSchema.safeParse(args);
    if (!parsed.success) return { status: 'invalid_domain', exposure: this.current };
    if (this.expansions >= MAX_CAPABILITY_EXPANSIONS_PER_TURN) return { status: 'expansion_limit', exposure: this.current };
    const domain = parsed.data.domain;
    const available = domainTools(this.catalog, domain, this.input);
    // Enabled modules and chat scope make a capability relevant to this chat; admin also needs owner.
    // Do not require a lexical hit: the meta-tool must recover domains missed by lexical selection.
    if (!available.length) return { status: 'not_relevant_or_allowed', exposure: this.current };
    const existing = this.catalog.filter(tool => this.current.toolNames.includes(tool.name));
    const missing = available.filter(tool => !this.current.toolNames.includes(tool.name));
    if (missing.length && existing.length >= MAX_TOOLS_PER_TURN - 1) return { status: 'capacity', exposure: this.current };
    const tools = [...existing, ...missing.slice(0, MAX_TOOLS_PER_TURN - 1 - existing.length)];
    this.current = snapshot(tools, [...new Set([...this.current.relevantDomains, domain])], this.input);
    this.expansions++;
    return { status: 'ok', exposure: this.current };
  }
}
