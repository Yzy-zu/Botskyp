import { existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelCapability, ProviderId } from './types.js';

export const CURRENT_QUALIFICATION_VERSION = 'v1';

export type QualifiedManifestEntry = {
  qualificationVersion: string;
  provider: ProviderId;
  model: string;
  toolCount: number;
  toolSchemaHash: string;
  qualifiedAt: string;
  status: 'FULL_CATALOG_SMOKE_COMPATIBLE' | 'CHAT_ONLY' | 'UNQUALIFIED';
  agentCompatible: boolean;
  chatCompatible: boolean;
  fullCatalogCompatible: boolean;
  latencyMs?: number;
  testedAt?: string;
  notes?: string;
};

export interface ToolDeclarationForHashing {
  name: string;
  description: string;
  parametersJsonSchema?: Record<string, unknown>;
}

export function canonicalizeValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    result[k] = canonicalizeValue(obj[k]);
  }
  return result;
}

export function computeToolSchemaHash(tools: readonly ToolDeclarationForHashing[]): string {
  const canonicalDeclarations = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: canonicalizeValue(tool.parametersJsonSchema ?? {}),
    }));
  return createHash('sha256').update(JSON.stringify(canonicalDeclarations)).digest('hex');
}

let registeredCatalogHash: { hash: string; toolCount: number } | undefined;

export function registerToolCatalog(tools: readonly ToolDeclarationForHashing[]): string {
  const hash = computeToolSchemaHash(tools);
  registeredCatalogHash = { hash, toolCount: tools.length };
  loadQualificationManifest();
  return hash;
}

export function getCurrentToolSchemaHash(): { hash: string; toolCount: number } {
  return registeredCatalogHash ?? { hash: '', toolCount: 0 };
}


const KNOWN_CAPABILITIES: Record<string, ModelCapability> = {
  // Gemini Models (Primary production qualified)
  'gemini:gemini-3.5-flash-lite': {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: true,
    contextWindow: 1_048_576,
    knownInputTokenLimit: 1_048_576,
    fullCatalogCompatible: true,
    chatCompatible: true,
    agentCompatible: true,
    enabled: true,
  },
  'gemini:gemini-2.5-flash-lite': {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: true,
    contextWindow: 1_048_576,
    knownInputTokenLimit: 1_048_576,
    fullCatalogCompatible: true,
    chatCompatible: true,
    agentCompatible: true,
    enabled: true,
  },
  'gemini:gemini-3.8-flash': {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: true,
    contextWindow: 1_048_576,
    knownInputTokenLimit: 1_048_576,
    fullCatalogCompatible: true,
    chatCompatible: true,
    agentCompatible: true,
    enabled: true,
  },

  // Groq Models (Baseline defaults; agentCompatible requires empirical qualification)
  'groq:llama-3.3-70b-versatile': {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: false,
    contextWindow: 128_000,
    knownInputTokenLimit: 128_000,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: true,
  },
  'groq:llama-3.1-8b-instant': {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: false,
    contextWindow: 128_000,
    knownInputTokenLimit: 128_000,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: true,
  },
  'groq:qwen/qwen-2.5-coder-32b': {
    provider: 'groq',
    model: 'qwen/qwen-2.5-coder-32b',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: false,
    contextWindow: 32_768,
    knownInputTokenLimit: 32_768,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: true,
  },
  'groq:mixtral-8x7b-32768': {
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
    supportsTools: false,
    supportsParallelTools: false,
    supportsJsonSchema: false,
    supportsVision: false,
    contextWindow: 32_768,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: false,
  },

  // OpenRouter Models
  'openrouter:meta-llama/llama-3.3-70b-instruct': {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.3-70b-instruct',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: false,
    contextWindow: 128_000,
    knownInputTokenLimit: 128_000,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: true,
  },
  'openrouter:google/gemini-2.0-flash-001': {
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-001',
    supportsTools: true,
    supportsParallelTools: true,
    supportsJsonSchema: true,
    supportsVision: true,
    contextWindow: 1_048_576,
    knownInputTokenLimit: 1_048_576,
    fullCatalogCompatible: false,
    chatCompatible: true,
    agentCompatible: false,
    enabled: true,
  },
};

const dynamicOverrides = new Map<string, Partial<ModelCapability>>();
const DEFAULT_MANIFEST_PATH = resolve(process.cwd(), 'var/llm-qualified-models.json');

export function getManifestPath(): string {
  return process.env.QUALIFICATION_MANIFEST_PATH
    ? resolve(process.cwd(), process.env.QUALIFICATION_MANIFEST_PATH)
    : DEFAULT_MANIFEST_PATH;
}

export function loadQualificationManifest(
  path = getManifestPath(),
  currentCatalogInfo?: { hash: string; toolCount: number } | readonly ToolDeclarationForHashing[],
): void {
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    let expectedHash: string;
    if (currentCatalogInfo) {
      expectedHash = 'hash' in currentCatalogInfo
        ? currentCatalogInfo.hash
        : computeToolSchemaHash(currentCatalogInfo);
    } else {
      expectedHash = getCurrentToolSchemaHash().hash;
    }

    for (const item of parsed) {
      if (item && typeof item === 'object' && item.provider && item.model) {
        const isSupportedVersion = item.qualificationVersion === CURRENT_QUALIFICATION_VERSION;
        const isSchemaMatch = Boolean(expectedHash && item.toolSchemaHash && item.toolSchemaHash === expectedHash);

        const isFullSmoke = isSupportedVersion && isSchemaMatch && item.status === 'FULL_CATALOG_SMOKE_COMPATIBLE' && item.agentCompatible === true;

        setModelCapabilityOverride(item.provider, item.model, {
          agentCompatible: isFullSmoke,
          fullCatalogCompatible: isFullSmoke,
          chatCompatible: Boolean(item.chatCompatible),
        });
      }
    }
  } catch {
    // Graceful fallback to static matrix
  }
}

export function saveQualificationManifest(entries: QualifiedManifestEntry[], path = getManifestPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(entries, null, 2);
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'w');
    writeSync(fd, content, 0, 'utf8');
    try {
      fsyncSync(fd);
    } catch {
      // ignore fsync if unsupported by underlying filesystem
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close error */ }
    }
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* ignore unlink error */ }
    throw err;
  }
  closeSync(fd);
  renameSync(tempPath, path);
  loadQualificationManifest(path);
}

// Deterministically load qualification manifest at module startup
loadQualificationManifest();


export function getModelCapability(provider: ProviderId, model: string): ModelCapability {
  const key = `${provider}:${model}`;
  const base = KNOWN_CAPABILITIES[key] ?? {
    provider,
    model,
    supportsTools: provider === 'gemini',
    supportsParallelTools: provider === 'gemini',
    supportsJsonSchema: true,
    supportsVision: provider === 'gemini',
    contextWindow: provider === 'gemini' ? 1_048_576 : 128_000,
    fullCatalogCompatible: provider === 'gemini',
    chatCompatible: true,
    agentCompatible: provider === 'gemini',
    enabled: true,
  };

  const override = dynamicOverrides.get(key);
  if (!override) return base;
  return { ...base, ...override };
}

export function setModelCapabilityOverride(provider: ProviderId, model: string, capability: Partial<ModelCapability>): void {
  const key = `${provider}:${model}`;
  dynamicOverrides.set(key, { ...dynamicOverrides.get(key), ...capability });
}

export function clearModelCapabilityOverrides(): void {
  dynamicOverrides.clear();
  loadQualificationManifest();
}

