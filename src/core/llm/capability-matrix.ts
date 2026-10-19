import type { ModelCapability, ProviderId } from './types.js';

const KNOWN_CAPABILITIES: Record<string, ModelCapability> = {
  // Gemini Models
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
    knownRateLimitWhenAvailable: { tpm: 100_000, rpm: 30 },
    fullCatalogCompatible: false, // Must be qualified before enabling as full agentic
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
    knownRateLimitWhenAvailable: { tpm: 100_000, rpm: 30 },
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
}
