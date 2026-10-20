import { z } from 'zod';
import { product } from '../../config/product.js';
import type { Actor } from './permissions.js';
import { capabilityDomains, capabilityDomainSchema, type CapabilityDomain } from './capability-domain.js';
import { alwaysOnBusinessTools, modelDeclaration, fullCatalogDeclarations, sessionConfirmMetaTool, sessionCancelMetaTool, type ToolMetadataV2 } from './tool-registry-v2.js';
import type { Declaration } from './llm.js';
import { loadArtifactContextMetaTool, loadArtifactContextSchema } from './tool-registry-v2.js';
export { sessionConfirmMetaTool, sessionCancelMetaTool } from './tool-registry-v2.js';
import { adapterAvailable } from './policy-v2/arguments.js';

export const MAX_TOOLS_PER_TURN = product.maxToolsPerTurn;
export const MAX_CAPABILITY_EXPANSIONS_PER_TURN = product.maxCapabilityExpansionsPerTurn;
export type ArtifactContext = { kind: string; mime?: string };
export interface ToolExposureInput {
  /** Compatibility input only; never read for exposure. */
  text?: string;
  quotedText?: string;
  actorRole: Actor['role'];
  chatType: 'group' | 'private';
  enabledModules: readonly string[];
  currentAttachment?: ArtifactContext;
  currentArtifact?: ArtifactContext;
  activeSession?: { domain: CapabilityDomain; kind?: 'confirm' | 'clarify' | 'media_collect'; pendingTool?: string };
  openPoll?: boolean;
  activeGame?: boolean;
  openCooperacha?: boolean;
  recentArtifactContext?: readonly ArtifactContext[];
  disableLexicalOptimization?: boolean;
  toolCallingMode?: 'full_96' | 'dynamic';
  mode?: 'full_96' | 'dynamic';
}
export interface ToolExposure {
  readonly toolNames: readonly string[];
  readonly schemas: readonly Declaration[];
  readonly selectedDomains: readonly CapabilityDomain[];
  readonly relevantDomains: readonly CapabilityDomain[];
  readonly availableDomains: readonly CapabilityDomain[];
  readonly capabilityDirectory: Readonly<Partial<Record<CapabilityDomain, string>>>;
  readonly approximateSchemaBytes: number;
}
function relevantDomains(input: ToolExposureInput): CapabilityDomain[] {
  const domains: CapabilityDomain[] = ['core'];
  if (input.activeSession) domains.push(input.activeSession.domain);
  if (input.currentAttachment || input.currentArtifact) domains.push('media');
  if (input.activeGame) domains.push('games');
  if (input.openPoll) domains.push('polls');
  if (input.openCooperacha) domains.push('library');
  return [...new Set(domains)];
}
function eligible(tool: ToolMetadataV2, input: ToolExposureInput): boolean {
  return tool.llmVisible && tool.exposure !== 'internal'
    && adapterAvailable(tool.name)
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
export const loadCapabilityArgsSchema = z.strictObject({
  domain: capabilityDomainSchema,
  toolName: z.string().regex(/^[a-z]+\.[a-z][a-z_-]*$/u).optional()
    .describe('Nombre exacto del Manifest, si ya identificaste la función necesaria; se prioriza su schema dentro del presupuesto.'),
});
export const loadCapabilityMetaTool = Object.freeze({
  name: 'core.load_capability', domain: 'core', llmVisible: true, exposure: 'always',
  descriptionForModel: 'Cargar funciones de un dominio disponible cuyas funciones aún no están expuestas. Usa literalmente domain del schema. Incluye toolName con el nombre EXACTO del Manifest de la función que necesitas para priorizarla dentro del presupuesto. Una expansión máxima; sin ejecutar acciones. Visibilidad nunca concede permiso.',
  modelArgsSchema: loadCapabilityArgsSchema,
});
function metaDeclarations(input: ToolExposureInput): { names: string[]; declarations: Declaration[] } {
  const isFull96 = (input.toolCallingMode ?? input.mode) === 'full_96';
  const emptySchema = z.toJSONSchema(sessionConfirmMetaTool.modelArgsSchema); delete emptySchema.$schema;
  const artifactSchema = z.toJSONSchema(loadArtifactContextSchema); delete artifactSchema.$schema;
  const names: string[] = [];
  const declarations: Declaration[] = [];
  if (!isFull96) {
    const loadSchema = z.toJSONSchema(loadCapabilityArgsSchema); delete loadSchema.$schema;
    names.push(loadCapabilityMetaTool.name);
    declarations.push({ name: 'core_load_capability', description: loadCapabilityMetaTool.descriptionForModel, parametersJsonSchema: loadSchema });
  }
  names.push(loadArtifactContextMetaTool.name);
  declarations.push({ name: 'core_load_artifact_context', description: loadArtifactContextMetaTool.description, parametersJsonSchema: artifactSchema });
  if (isFull96 || input.activeSession?.kind === 'confirm') {
    names.push(sessionConfirmMetaTool.name);
    declarations.push({ name: 'core_session_confirm', description: sessionConfirmMetaTool.descriptionForModel, parametersJsonSchema: emptySchema });
  }
  if (isFull96 || input.activeSession?.kind) {
    names.push(sessionCancelMetaTool.name);
    declarations.push({ name: 'core_session_cancel', description: sessionCancelMetaTool.descriptionForModel, parametersJsonSchema: emptySchema });
  }
  return { names, declarations };
}
function snapshot(catalog: readonly ToolMetadataV2[], tools: readonly ToolMetadataV2[], relevant: readonly CapabilityDomain[], input: ToolExposureInput): ToolExposure {
  const meta = metaDeclarations(input);
  const schemas = (input.toolCallingMode ?? input.mode) === 'full_96'
    ? fullCatalogDeclarations(catalog) : [...tools.map(modelDeclaration), ...meta.declarations];
  const availableDomains = capabilityDomains.filter(domain => domainTools(catalog, domain, input).length > 0);
  const capabilityDirectory = Object.fromEntries(availableDomains.map(domain => [domain,
    `${domain[0]!.toUpperCase()}${domain.slice(1)}: ${domainTools(catalog,domain,input).map(tool=>tool.capability?.summary ?? tool.descriptionForModel).join(' ')}`,
  ])) as Partial<Record<CapabilityDomain, string>>;
  return Object.freeze({
    toolNames: Object.freeze([...tools.map(tool => tool.name), ...meta.names]),
    schemas: Object.freeze(schemas), selectedDomains: Object.freeze([...new Set<CapabilityDomain>(['core', ...tools.map(tool => tool.domain)])]),
    relevantDomains: Object.freeze([...relevant]),
    availableDomains: Object.freeze(availableDomains),
    capabilityDirectory: Object.freeze(capabilityDirectory),
    approximateSchemaBytes: Buffer.byteLength(JSON.stringify(schemas), 'utf8'),
  });
}
function baseTools(catalog: readonly ToolMetadataV2[], input: ToolExposureInput): ToolMetadataV2[] {
  return alwaysOnBusinessTools.flatMap(name => catalog.filter(tool => tool.name === name && eligible(tool, input)));
}
export function selectToolExposure(catalog: readonly ToolMetadataV2[], input: ToolExposureInput): ToolExposure {
  const isFull96 = (input.toolCallingMode ?? input.mode) === 'full_96';
  if (isFull96) {
    const publicTools = catalog.filter(tool => tool.llmVisible && tool.exposure !== 'internal');
    return snapshot(catalog, publicTools, capabilityDomains, input);
  }
  const metaCount = metaDeclarations(input).names.length;
  const maxBusiness = MAX_TOOLS_PER_TURN - metaCount;
  const tools = baseTools(catalog, input).slice(0, maxBusiness);
  if (input.activeSession?.pendingTool) {
    const pending = catalog.find(tool => tool.name === input.activeSession?.pendingTool && eligible(tool, input));
    if (pending && !tools.includes(pending) && tools.length < maxBusiness) tools.push(pending);
  }
  if (input.activeSession?.kind === 'media_collect') {
    const collectTool = catalog.find(tool => tool.name === 'media.collect' && eligible(tool, input));
    if (collectTool && !tools.includes(collectTool) && tools.length < maxBusiness) tools.push(collectTool);
  }
  const relevant = relevantDomains(input);
  // Preserve one representative per relevant non-admin domain before filling a large catalog.
  // This prevents a school session from displacing an attached document's media capability.
  for (const domain of relevant.filter(domain => domain !== 'core' && domain !== 'admin')) {
    const representative = domainTools(catalog, domain, input).find(tool => !tools.includes(tool));
    if (representative && tools.length < maxBusiness) tools.push(representative);
  }
  for (const domain of relevant) {
    // Core contributes only the definitive always-on set. Admin is last, including role fallback.
    if (domain === 'core') continue;
    for (const tool of domainTools(catalog, domain, input)) {
      if (tools.length >= maxBusiness) break;
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return snapshot(catalog, tools, relevant, input);
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
  /** Fit the actual provider envelope too, retaining meta-tools for discovery and sessions. */
  fitSchemaBudget(maxChars: number): void {
    // Full mode is qualified as one catalog; the caller rejects an oversized request.
    if ((this.input.toolCallingMode ?? this.input.mode) === 'full_96') return;
    const tools = this.catalog.filter(tool => this.current.toolNames.includes(tool.name))
      .sort((a,b)=>this.current.toolNames.indexOf(a.name)-this.current.toolNames.indexOf(b.name));
    while (JSON.stringify(this.current.schemas).length > maxChars && tools.length) {
      tools.pop();
      this.current = snapshot(this.catalog, tools, this.current.relevantDomains, this.input);
    }
  }
  loadCapability(args: unknown): CapabilityExpansion {
    if ((this.input.toolCallingMode ?? this.input.mode) === 'full_96') {
      return { status: 'not_relevant_or_allowed', exposure: this.current };
    }
    const parsed = loadCapabilityArgsSchema.safeParse(args);
    if (!parsed.success) return { status: 'invalid_domain', exposure: this.current };
    if (this.expansions >= MAX_CAPABILITY_EXPANSIONS_PER_TURN) return { status: 'expansion_limit', exposure: this.current };
    const domain = parsed.data.domain;
    const available = domainTools(this.catalog, domain, this.input);
    if(parsed.data.toolName){
      const index=available.findIndex(tool=>tool.name===parsed.data.toolName);
      if(index<0)return {status:'not_relevant_or_allowed',exposure:this.current};
      available.unshift(...available.splice(index,1));
    }
    // Enabled modules and chat scope make a capability relevant to this chat; admin also needs owner.
    // Do not require a lexical hit: the meta-tool must recover domains missed by lexical selection.
    if (!available.length) return { status: 'not_relevant_or_allowed', exposure: this.current };
    const maxBusiness = MAX_TOOLS_PER_TURN - metaDeclarations(this.input).names.length;
    // Discovery must expose the entire requested domain even when lexical/context preloading
    // filled the window. Rotate unrelated schemas out; preserve signed provider history and refs.
    if (available.length > maxBusiness) return { status: 'capacity', exposure: this.current };
    const existing = this.catalog.filter(tool => this.current.toolNames.includes(tool.name) && tool.domain !== domain);
    const tools = [...available, ...existing.slice(0, maxBusiness - available.length)];
    this.current = snapshot(this.catalog, tools, [...new Set([...this.current.relevantDomains, domain])], this.input);
    this.expansions++;
    return { status: 'ok', exposure: this.current };
  }
}
