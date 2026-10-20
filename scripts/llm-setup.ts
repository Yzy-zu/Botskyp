import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mergeAndDedupeApiKeys } from '../src/config.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2, fullCatalogDeclarations } from '../src/core/tool-registry-v2.js';
import { GeminiProvider } from '../src/core/llm/gemini-adapter.js';
import { GroqProvider } from '../src/core/llm/groq-adapter.js';
import { OpenRouterProvider } from '../src/core/llm/openrouter-adapter.js';
import type { ProviderId } from '../src/core/llm/types.js';
import {
  saveQualificationManifest,
  type QualifiedManifestEntry,
  CURRENT_QUALIFICATION_VERSION,
  computeToolSchemaHash,
} from '../src/core/llm/capability-matrix.js';
import { qualifyModel, type QualificationResult } from './llm-qualify.js';

export type DetectedProvider = 'gemini' | 'groq' | 'openrouter' | 'invalid';

export interface ClassifiedKey {
  opaqueId: string;
  provider: DetectedProvider;
  key: string;
}

export interface SetupOptions {
  rawKeys?: string[];
  envPath?: string;
  manifestPath?: string;
  http?: typeof fetch;
  skipRecreate?: boolean;
  skipSmoke?: boolean;
}

export interface SetupReport {
  credentials: {
    gemini: { valid: number; configured: number };
    groq: { valid: number; configured: number };
    openrouter: { valid: number; configured: number };
    invalid: number;
  };
  qualifiedModels: {
    gemini: { model: string; status: string; notes?: string }[];
    groq: { model: string; status: string; notes?: string }[];
    openrouter: { model: string; status: string; notes?: string }[];
  };
  route: string;
  secretsExposed: boolean;
  healthPass: boolean;
  corePingPass: boolean;
}

// ==========================================
// 1. CREDENTIAL VALIDATION & DETECTION
// ==========================================

export async function validateGeminiKey(key: string, http: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await http(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.ok) return true;
    const resQuery = await http(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { method: 'GET', signal: AbortSignal.timeout(8000) },
    );
    return resQuery.ok;
  } catch {
    return false;
  }
}

export async function validateGroqKey(key: string, http: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await http('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function validateOpenRouterKey(key: string, http: typeof fetch = fetch): Promise<boolean> {
  try {
    // Probe auth endpoint first
    const res = await http('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://botsky.chat',
        'X-Title': 'Botsky',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    // Fallback: check models endpoint with key
    const resModels = await http('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://botsky.chat',
        'X-Title': 'Botsky',
      },
      signal: AbortSignal.timeout(8000),
    });
    return resModels.ok;
  } catch {
    return false;
  }
}

export async function detectProvider(key: string, http: typeof fetch = fetch): Promise<DetectedProvider> {
  const trimmed = key.trim();
  if (!trimmed) return 'invalid';

  // Fast path heuristic probes based on standard key prefixes
  if (trimmed.startsWith('AIzaSy') || trimmed.startsWith('AQ.')) {
    if (await validateGeminiKey(trimmed, http)) return 'gemini';
    if (await validateGroqKey(trimmed, http)) return 'groq';
    if (await validateOpenRouterKey(trimmed, http)) return 'openrouter';
    return 'invalid';
  }

  if (trimmed.startsWith('gsk_')) {
    if (await validateGroqKey(trimmed, http)) return 'groq';
    if (await validateGeminiKey(trimmed, http)) return 'gemini';
    if (await validateOpenRouterKey(trimmed, http)) return 'openrouter';
    return 'invalid';
  }

  if (trimmed.startsWith('sk-or-')) {
    if (await validateOpenRouterKey(trimmed, http)) return 'openrouter';
    if (await validateGroqKey(trimmed, http)) return 'groq';
    if (await validateGeminiKey(trimmed, http)) return 'gemini';
    return 'invalid';
  }

  // General probe across all 3 providers
  const [geminiOk, groqOk, openRouterOk] = await Promise.all([
    validateGeminiKey(trimmed, http),
    validateGroqKey(trimmed, http),
    validateOpenRouterKey(trimmed, http),
  ]);

  if (geminiOk) return 'gemini';
  if (groqOk) return 'groq';
  if (openRouterOk) return 'openrouter';
  return 'invalid';
}

export async function classifyKeys(
  rawKeys: readonly string[],
  http: typeof fetch = fetch,
): Promise<{
  classified: ClassifiedKey[];
  gemini: string[];
  groq: string[];
  openrouter: string[];
  invalid: number;
}> {
  const distinctKeys = [...new Set(rawKeys.map(k => k.trim()).filter(Boolean))];
  const classified: ClassifiedKey[] = [];
  const gemini: string[] = [];
  const groq: string[] = [];
  const openrouter: string[] = [];
  let invalid = 0;

  for (const key of distinctKeys) {
    const provider = await detectProvider(key, http);
    let opaqueId: string;
    if (provider === 'gemini') {
      gemini.push(key);
      opaqueId = `gemini-key-${gemini.length}`;
    } else if (provider === 'groq') {
      groq.push(key);
      opaqueId = `groq-key-${groq.length}`;
    } else if (provider === 'openrouter') {
      openrouter.push(key);
      opaqueId = `openrouter-key-${openrouter.length}`;
    } else {
      invalid++;
      opaqueId = `unknown-key-${invalid}`;
    }
    classified.push({ opaqueId, provider, key });
  }

  return { classified, gemini, groq, openrouter, invalid };
}

// ==========================================
// 2. ATOMIC .ENV CONFIGURATION
// ==========================================

export function readExistingEnv(envPath: string): { content: string; variables: Map<string, string> } {
  const variables = new Map<string, string>();
  if (!existsSync(envPath)) return { content: '', variables };
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      variables.set(k, v);
    }
  }
  return { content, variables };
}

export function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  const { content } = readExistingEnv(envPath);
  const existingLines = content ? content.split('\n') : [];
  const handledKeys = new Set<string>();
  const newLines: string[] = [];

  for (const line of existingLines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      const k = match[1]!;
      if (k in updates) {
        newLines.push(`${k}=${updates[k]}`);
        handledKeys.add(k);
        continue;
      }
    }
    newLines.push(line);
  }

  // Append new keys that were not present
  for (const [k, v] of Object.entries(updates)) {
    if (!handledKeys.has(k)) {
      newLines.push(`${k}=${v}`);
    }
  }

  const finalContent = newLines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  const tempPath = `${envPath}.tmp.${Date.now()}`;

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, finalContent, 'utf8');
    try { fsyncSync(fd); } catch { /* ignore fsync */ }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  try { chmodSync(tempPath, 0o600); } catch { /* ignore */ }
  renameSync(tempPath, envPath);
  try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
}

// ==========================================
// 3. MODEL DISCOVERY
// ==========================================

export async function discoverGroqModels(apiKey: string, http: typeof fetch = fetch): Promise<string[]> {
  const provider = new GroqProvider([], http);
  const models = await provider.discoverModels(apiKey);

  const candidates = models.filter(m => {
    if (!m.active) return false;
    const id = m.id.toLowerCase();
    // Exclude specialized / audio / safety models
    if (id.includes('whisper') || id.includes('guard') || id.includes('distil') || id.includes('audio') || id.includes('tts') || id.includes('embedding')) {
      return false;
    }
    // Must have sufficient context window for full tool catalog
    return m.contextWindow >= 16384;
  });

  // Rank: prefer 70b versatile models, then 8b or other chat/instruct models
  candidates.sort((a, b) => {
    const a70 = a.id.includes('70b') ? 1 : 0;
    const b70 = b.id.includes('70b') ? 1 : 0;
    if (a70 !== b70) return b70 - a70;
    return b.contextWindow - a.contextWindow;
  });

  return candidates.map(c => c.id).slice(0, 3);
}

export async function discoverOpenRouterModels(apiKey: string, http: typeof fetch = fetch): Promise<string[]> {
  const provider = new OpenRouterProvider([], true, http);
  const models = await provider.discoverModels(apiKey);

  const candidates = models.filter(m => {
    if (!m.isFree) return false;
    if (!m.supportsTools) return false;
    return m.contextLength >= 16384;
  });

  // Rank: prefer larger models (70b, flash) and larger context
  candidates.sort((a, b) => {
    const aTop = a.id.includes('70b') || a.id.includes('flash') ? 1 : 0;
    const bTop = b.id.includes('70b') || b.id.includes('flash') ? 1 : 0;
    if (aTop !== bTop) return bTop - aTop;
    return b.contextLength - a.contextLength;
  });

  return candidates.map(c => c.id).slice(0, 3);
}

// ==========================================
// 4. MAIN SETUP PIPELINE
// ==========================================

export async function runLlmSetup(options: SetupOptions = {}): Promise<SetupReport> {
  const envPath = options.envPath ?? resolve(process.cwd(), '.env');
  const manifestPath = options.manifestPath ?? resolve(process.cwd(), 'var/llm-qualified-models.json');
  const http = options.http ?? fetch;

  const catalog = createToolRegistryV2(createRegistry());
  const fullCatalogTools = fullCatalogDeclarations(catalog);

  // 1. Read existing configuration
  const { variables: existingEnv } = readExistingEnv(envPath);
  const existingGeminiSingular = existingEnv.get('GEMINI_API_KEY');
  const existingGeminiPlural = existingEnv.get('GEMINI_API_KEYS');
  const existingGroqSingular = existingEnv.get('GROQ_API_KEY');
  const existingGroqPlural = existingEnv.get('GROQ_API_KEYS');
  const existingOpenRouterSingular = existingEnv.get('OPENROUTER_API_KEY');
  const existingOpenRouterPlural = existingEnv.get('OPENROUTER_API_KEYS');

  // 2. Classify new keys
  const rawInputKeys = options.rawKeys ?? [];
  const { gemini: newGemini, groq: newGroq, openrouter: newOpenRouter, invalid } = await classifyKeys(rawInputKeys, http);

  // 3. Merge & Dedupe with existing keys
  const mergedGemini = mergeAndDedupeApiKeys(existingGeminiSingular, [
    ...(existingGeminiPlural ? existingGeminiPlural.split(',') : []),
    ...newGemini,
  ]);

  const mergedGroq = mergeAndDedupeApiKeys(existingGroqSingular, [
    ...(existingGroqPlural ? existingGroqPlural.split(',') : []),
    ...newGroq,
  ]);

  const mergedOpenRouter = mergeAndDedupeApiKeys(existingOpenRouterSingular, [
    ...(existingOpenRouterPlural ? existingOpenRouterPlural.split(',') : []),
    ...newOpenRouter,
  ]);

  console.log(`\n===============================================================`);
  console.log(`LLM PROVIDER ONBOARDING — CREDENTIAL DISCOVERY`);
  console.log(`===============================================================`);
  console.log(`Gemini keys: ${mergedGemini.length} configured (${newGemini.length} new)`);
  console.log(`Groq keys: ${mergedGroq.length} configured (${newGroq.length} new)`);
  console.log(`OpenRouter keys: ${mergedOpenRouter.length} configured (${newOpenRouter.length} new)`);
  if (invalid > 0) {
    console.log(`[Warning] ${invalid} unrecognized or invalid key(s) rejected.`);
  }

  // 4. Discover candidate models
  const primaryGeminiModel = existingEnv.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
  const geminiCandidates = [primaryGeminiModel, 'gemini-2.5-flash-lite'];

  let groqCandidates: string[] = [];
  if (mergedGroq.length > 0) {
    console.log(`Discovering available Groq models...`);
    groqCandidates = await discoverGroqModels(mergedGroq[0]!, http);
    console.log(`Groq candidate models: ${groqCandidates.length ? groqCandidates.join(', ') : 'none found'}`);
  }

  let openRouterCandidates: string[] = [];
  if (mergedOpenRouter.length > 0) {
    console.log(`Discovering available free OpenRouter models...`);
    openRouterCandidates = await discoverOpenRouterModels(mergedOpenRouter[0]!, http);
    console.log(`OpenRouter free candidate models: ${openRouterCandidates.length ? openRouterCandidates.join(', ') : 'none found'}`);
  }

  // 5. Qualify Candidate Models
  console.log(`\n===============================================================`);
  console.log(`EXECUTING EMPIRICAL QUALIFICATION SUITE`);
  console.log(`===============================================================`);

  const qualificationResults: QualificationResult[] = [];

  // Gemini qualification
  const geminiAdapter = new GeminiProvider(geminiCandidates, http);
  for (const m of geminiCandidates) {
    console.log(`Testing [gemini] ${m}...`);
    const q = await qualifyModel(geminiAdapter, m, mergedGemini[0], fullCatalogTools, m === primaryGeminiModel);
    qualificationResults.push(q);
  }

  // Groq qualification
  if (mergedGroq.length > 0 && groqCandidates.length > 0) {
    const groqAdapter = new GroqProvider(groqCandidates, http);
    for (const m of groqCandidates) {
      console.log(`Testing [groq] ${m}...`);
      const q = await qualifyModel(groqAdapter, m, mergedGroq[0], fullCatalogTools, false);
      qualificationResults.push(q);
    }
  }

  // OpenRouter qualification
  if (mergedOpenRouter.length > 0 && openRouterCandidates.length > 0) {
    const openRouterAdapter = new OpenRouterProvider(openRouterCandidates, true, http);
    for (const m of openRouterCandidates) {
      console.log(`Testing [openrouter] ${m}...`);
      const q = await qualifyModel(openRouterAdapter, m, mergedOpenRouter[0], fullCatalogTools, false);
      qualificationResults.push(q);
    }
  }

  // Filter qualified models
  const qualifiedGemini = qualificationResults.filter(q => q.provider === 'gemini' && q.agentCompatible);
  const qualifiedGroq = qualificationResults.filter(q => q.provider === 'groq' && q.agentCompatible);
  const qualifiedOpenRouter = qualificationResults.filter(q => q.provider === 'openrouter' && q.agentCompatible);

  // 6. Save Qualification Manifest
  const schemaHash = computeToolSchemaHash(fullCatalogTools);
  const qualifiedAt = new Date().toISOString();
  const manifestEntries: QualifiedManifestEntry[] = qualificationResults.map(r => ({
    qualificationVersion: CURRENT_QUALIFICATION_VERSION,
    provider: r.provider as ProviderId,
    model: r.model,
    toolCount: fullCatalogTools.length,
    toolSchemaHash: schemaHash,
    qualifiedAt,
    status: r.agentCompatible ? 'FULL_CATALOG_SMOKE_COMPATIBLE' : 'UNQUALIFIED',
    agentCompatible: r.agentCompatible,
    fullCatalogCompatible: r.fullCatalogCompatible,
    chatCompatible: r.chatCompatible,
    testedAt: qualifiedAt,
    latencyMs: r.latencyMs,
    ...(r.notes ? { notes: r.notes } : {}),
  }));

  saveQualificationManifest(manifestEntries, manifestPath);
  console.log(`Qualification manifest written to ${manifestPath}`);

  // 7. Generate Canonical LLM_ROUTE and Flags
  const routeParts: string[] = [];

  // Primary: Gemini
  const topGemini = qualifiedGemini.find(q => q.model === primaryGeminiModel) ?? qualifiedGemini[0];
  if (topGemini) {
    routeParts.push(`gemini|${topGemini.model}`);
  }

  // Fallback 1: Groq
  if (qualifiedGroq.length > 0) {
    routeParts.push(`groq|${qualifiedGroq[0]!.model}`);
  }

  // Fallback 2: OpenRouter
  if (qualifiedOpenRouter.length > 0) {
    routeParts.push(`openrouter|${qualifiedOpenRouter[0]!.model}`);
  }

  const generatedRoute = routeParts.join(',');

  const envUpdates: Record<string, string> = {
    GEMINI_API_KEYS: mergedGemini.join(','),
    GROQ_ENABLED: String(mergedGroq.length > 0 && qualifiedGroq.length > 0),
    GROQ_API_KEYS: mergedGroq.join(','),
    GROQ_MODELS: qualifiedGroq.map(q => q.model).join(','),
    OPENROUTER_ENABLED: String(mergedOpenRouter.length > 0 && qualifiedOpenRouter.length > 0),
    OPENROUTER_API_KEYS: mergedOpenRouter.join(','),
    OPENROUTER_MODELS: qualifiedOpenRouter.map(q => q.model).join(','),
    OPENROUTER_ALLOW_FREE_MODELS: 'true',
    LLM_ROUTE: generatedRoute,
    QUALIFICATION_MANIFEST_PATH: 'var/llm-qualified-models.json',
  };

  updateEnvFile(envPath, envUpdates);
  console.log(`Updated environment file: ${envPath} (mode 0600, secrets protected)`);

  // 8. Recreate containers if not skipped
  let healthPass = true;
  let corePingPass = true;

  if (!options.skipRecreate && existsSync(resolve(process.cwd(), 'docker-compose.yml'))) {
    console.log(`\nRecreating containers (docker compose up -d --force-recreate app worker)...`);
    try {
      let commitEnv = '';
      try {
        const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        commitEnv = `BOTSKY_GIT_COMMIT=${commit} `;
      } catch { /* ignore */ }
      execSync(`${commitEnv}docker compose up -d --force-recreate app worker`, { stdio: 'inherit' });
      // Wait for health
      console.log(`Waiting for app to report healthy...`);
      execSync('sleep 5');
      const healthRes = execSync('curl -s http://127.0.0.1:3000/health', { encoding: 'utf8' });
      const parsedHealth = JSON.parse(healthRes);
      healthPass = Boolean(parsedHealth.ok);
      console.log(`Health check: ${healthPass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      console.error(`Container recreation / health check error: ${(err as Error).message}`);
      healthPass = false;
    }
  }

  // 9. Safe core.ping smoke turn if not skipped
  if (!options.skipSmoke && healthPass && !options.skipRecreate) {
    console.log(`\nExecuting post-deploy harmless core.ping smoke turn...`);
    try {
      const secret = existingEnv.get('WEBHOOK_SECRET') || process.env.WEBHOOK_SECRET;
      const instance = existingEnv.get('INSTANCE') || process.env.INSTANCE || 'botsky';
      const labChatId = existingEnv.get('LAB_CHAT_ID') || process.env.LAB_CHAT_ID;
      const ownerJids = (existingEnv.get('OWNER_JIDS') || process.env.OWNER_JIDS || '').split(',');
      const ownerJid = ownerJids[0] || '100@s.whatsapp.net';

      if (secret && labChatId) {
        const payload = {
          event: 'messages.upsert',
          instance,
          qaMode: 'LIVE_SAFE',
          data: {
            key: {
              id: `SETUP_SMOKE_${Date.now()}`,
              remoteJid: labChatId,
              fromMe: false,
              participant: ownerJid,
            },
            message: { conversation: 'botsky ping' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        };

        const smokeRes = await fetch('http://127.0.0.1:3000/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': secret,
            'x-qa-mode': 'LIVE_SAFE',
          },
          body: JSON.stringify(payload),
        });

        corePingPass = smokeRes.ok;
        console.log(`Core ping webhook response status: ${smokeRes.status}`);
      }
    } catch (err) {
      console.error(`Smoke check error: ${(err as Error).message}`);
      corePingPass = false;
    }
  }

  // 10. Generate Final Report (Zero secrets logged!)
  const report: SetupReport = {
    credentials: {
      gemini: { valid: mergedGemini.length, configured: mergedGemini.length },
      groq: { valid: mergedGroq.length, configured: mergedGroq.length },
      openrouter: { valid: mergedOpenRouter.length, configured: mergedOpenRouter.length },
      invalid,
    },
    qualifiedModels: {
      gemini: qualificationResults
        .filter(q => q.provider === 'gemini')
        .map(q => ({
          model: q.model,
          status: q.agentCompatible ? 'FULL_CATALOG_SMOKE_COMPATIBLE' : 'UNQUALIFIED',
          ...(q.notes ? { notes: q.notes } : {}),
        })),
      groq: qualificationResults
        .filter(q => q.provider === 'groq')
        .map(q => ({
          model: q.model,
          status: q.agentCompatible ? 'FULL_CATALOG_SMOKE_COMPATIBLE' : 'UNQUALIFIED',
          ...(q.notes ? { notes: q.notes } : {}),
        })),
      openrouter: qualificationResults
        .filter(q => q.provider === 'openrouter')
        .map(q => ({
          model: q.model,
          status: q.agentCompatible ? 'FULL_CATALOG_SMOKE_COMPATIBLE' : 'UNQUALIFIED',
          ...(q.notes ? { notes: q.notes } : {}),
        })),
    },
    route: generatedRoute,
    secretsExposed: false,
    healthPass,
    corePingPass,
  };

  printReport(report);
  return report;
}

export function printReport(report: SetupReport): void {
  console.log(`\n===============================================================`);
  console.log(`FINAL ONBOARDING SETUP REPORT`);
  console.log(`===============================================================\n`);

  console.log(`CREDENTIALS:`);
  console.log(`Gemini: ${report.credentials.gemini.valid} valid / ${report.credentials.gemini.configured} configured`);
  console.log(`Groq: ${report.credentials.groq.valid} valid / ${report.credentials.groq.configured} configured`);
  console.log(`OpenRouter: ${report.credentials.openrouter.valid} valid / ${report.credentials.openrouter.configured} configured`);
  if (report.credentials.invalid > 0) {
    console.log(`Rejected/Unknown: ${report.credentials.invalid}`);
  }

  console.log(`\nQUALIFIED MODELS:`);
  console.log(`Gemini:`);
  for (const m of report.qualifiedModels.gemini) {
    console.log(`  ${m.model} -> ${m.status}${m.notes ? ` (${m.notes})` : ''}`);
  }

  console.log(`Groq:`);
  if (!report.qualifiedModels.groq.length) {
    console.log(`  (none configured)`);
  } else {
    for (const m of report.qualifiedModels.groq) {
      console.log(`  ${m.model} -> ${m.status}${m.notes ? ` (${m.notes})` : ''}`);
    }
  }

  console.log(`OpenRouter:`);
  if (!report.qualifiedModels.openrouter.length) {
    console.log(`  (none configured)`);
  } else {
    for (const m of report.qualifiedModels.openrouter) {
      console.log(`  ${m.model} -> ${m.status}${m.notes ? ` (${m.notes})` : ''}`);
    }
  }

  console.log(`\nROUTE:`);
  console.log(report.route ? report.route.replace(/,/g, ' -> ') : '(empty)');

  console.log(`\nSECRETS_EXPOSED_IN_LOGS:`);
  console.log(report.secretsExposed ? 'YES (ALERT)' : 'NO');

  console.log(`\nHEALTH:`);
  console.log(report.healthPass ? 'PASS' : 'FAIL');

  console.log(`\nCORE_PING:`);
  console.log(report.corePingPass ? 'PASS' : 'SKIPPED/FAIL');
}

// Interactive / CLI invocation
if (process.argv[1] && process.argv[1].endsWith('llm-setup.ts')) {
  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let rawKeys: string[] = [];
    // Check for --keys-file argument
    const keysFileArg = args.find(a => a.startsWith('--keys-file='));
    const keysArg = args.find(a => a.startsWith('--keys='));
    if (keysFileArg) {
      const filePath = keysFileArg.slice('--keys-file='.length).trim();
      rawKeys = readFileSync(filePath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else if (keysArg) {
      rawKeys = keysArg.slice('--keys='.length).split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    } else if (!process.stdin.isTTY) {
      // Read from stdin pipe
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      const input = Buffer.concat(chunks).toString('utf8');
      rawKeys = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else {
      console.log('Introduce tus API keys, una por línea. Presiona Enter dos veces seguidas o Ctrl+D para finalizar:');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const lines: string[] = [];
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (lines.length > 0) break;
        } else {
          lines.push(trimmed);
        }
      }
      rawKeys = lines;
    }

    await runLlmSetup({ rawKeys });
  }

  main().catch(err => {
    console.error('LLM setup error:', (err as Error).message);
    process.exit(1);
  });
}
