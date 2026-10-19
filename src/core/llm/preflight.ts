import { product } from '../../../config/product.js';
import type { LlmInput, ModelCapability, PreflightDecision } from './types.js';

export function estimateRequestTokens(input: LlmInput): number {
  let imageCount = 0;
  const text = JSON.stringify(input, (key, value: unknown) => {
    if (key === 'inlineData' || key === 'data') {
      imageCount++;
      return '[image]';
    }
    return value;
  });
  // Rough estimate: ~3.5 chars per token for typical multi-lingual / JSON content, plus safety margin.
  const rawBytes = Buffer.byteLength(text, 'utf8');
  const tokenEst = Math.ceil(rawBytes / 3.5);
  return tokenEst + product.llmTokenSafetyMargin + imageCount * product.llmImageReservedTokens;
}

export function tokenPreflight(capability: ModelCapability, input: LlmInput): PreflightDecision {
  const estimatedTokens = estimateRequestTokens(input);
  const reservedOutput = product.llmMaxOutputTokens;

  // Check 1: Model Context Window reserving output budget (estimatedInput + reservedOutput <= contextWindow)
  if (capability.contextWindow > 0 && (estimatedTokens + reservedOutput) > capability.contextWindow) {
    return {
      ok: false,
      reason: 'MODEL_REQUEST_TOO_LARGE',
      estimatedTokens,
      limit: capability.contextWindow,
    };
  }

  // Check 2: Known Input Token Limit (if stricter than full context window)
  if (capability.knownInputTokenLimit && capability.knownInputTokenLimit > 0 && estimatedTokens > capability.knownInputTokenLimit) {
    return {
      ok: false,
      reason: 'MODEL_REQUEST_TOO_LARGE',
      estimatedTokens,
      limit: capability.knownInputTokenLimit,
    };
  }

  return { ok: true, estimatedTokens };
}

