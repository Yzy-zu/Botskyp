import { readConfig } from '../src/config.js';
import { existsSync } from 'node:fs';

if (process.loadEnvFile && existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* ignore */ }
}

function extractError(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    return String(rec.providerErrorCode ?? rec.status ?? (err as Error).message ?? err);
  }
  return String(err);
}

import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2, registryV2Declarations } from '../src/core/tool-registry-v2.js';
import { GeminiProvider } from '../src/core/llm/gemini-adapter.js';
import { GroqProvider } from '../src/core/llm/groq-adapter.js';
import { OpenRouterProvider } from '../src/core/llm/openrouter-adapter.js';
import type { LlmProviderAdapter } from '../src/core/llm/provider-adapter.js';
import type { LlmInput } from '../src/core/llm/types.js';

interface QualificationResult {
  provider: string;
  model: string;
  hasCredentials: boolean;
  plainChatOk: boolean;
  simpleToolOk: boolean;
  argsToolOk: boolean;
  fullCatalogCompatible: boolean;
  toolLoopCompleted: boolean;
  latencyMs: number;
  agentCompatible: boolean;
  chatCompatible: boolean;
  qualifiedRole: 'primary' | 'fallback' | 'chat_only' | 'none';
  notes: string;
}

async function qualifyModel(
  adapter: LlmProviderAdapter,
  model: string,
  apiKey: string | undefined,
  fullCatalogTools: ReturnType<typeof registryV2Declarations>,
  isPrimaryCandidate: boolean,
): Promise<QualificationResult> {
  const result: QualificationResult = {
    provider: adapter.id,
    model,
    hasCredentials: Boolean(apiKey),
    plainChatOk: false,
    simpleToolOk: false,
    argsToolOk: false,
    fullCatalogCompatible: false,
    toolLoopCompleted: false,
    latencyMs: 0,
    agentCompatible: false,
    chatCompatible: false,
    qualifiedRole: 'none',
    notes: '',
  };

  if (!apiKey) {
    result.notes = 'Sin credenciales configuradas en el entorno actual';
    return result;
  }

  const latencies: number[] = [];

  // A. Plain chat test
  try {
    const t0 = performance.now();
    const chatReq: LlmInput = {
      system: 'Eres Botsky, un asistente de WhatsApp amigable. Responde brevemente.',
      contents: [{ role: 'user', parts: [{ text: 'ola botsky' }] }],
      tools: [],
    };
    const chatRes = await adapter.generate(chatReq, model, apiKey, 'qualify-key');
    latencies.push(performance.now() - t0);
    if (chatRes.text && chatRes.text.trim().length > 0) {
      result.plainChatOk = true;
      result.chatCompatible = true;
    }
  } catch (err) {
    result.notes += `[Chat: ${(err as Error).message}] `;
  }

  // B. Simple no-args tool with full catalog
  let toolCallId: string | undefined;
  let toolCallName: string | undefined;
  let toolResContent: unknown;
  try {
    const t0 = performance.now();
    const toolReq: LlmInput = {
      system: 'Eres Botsky. Si preguntan si el servidor de Minecraft está vivo o encendido, debes llamar a la función adecuada.',
      contents: [{ role: 'user', parts: [{ text: 'oye el maicra sige bibo?' }] }],
      tools: fullCatalogTools,
    };
    const toolRes = await adapter.generate(toolReq, model, apiKey, 'qualify-key');
    latencies.push(performance.now() - t0);
    toolResContent = toolRes.content;
    if (toolRes.calls && toolRes.calls.length > 0) {
      const call = toolRes.calls[0]!;
      toolCallId = call.id;
      toolCallName = call.name;
      result.simpleToolOk = true;
    }
  } catch (err) {
    result.notes += `[Simple tool: ${extractError(err)}] `;
  }

  // C. Args tool with full catalog
  try {
    const t0 = performance.now();
    const argsReq: LlmInput = {
      system: 'Eres Botsky. Si piden buscar videos o buscar en la web, debes invocar la herramienta correspondiente con sus parámetros.',
      contents: [{ role: 'user', parts: [{ text: 'busca videos en dailymotion de minecraft' }] }],
      tools: fullCatalogTools,
    };
    const argsRes = await adapter.generate(argsReq, model, apiKey, 'qualify-key');
    latencies.push(performance.now() - t0);
    if (argsRes.calls && argsRes.calls.length > 0) {
      const call = argsRes.calls[0]!;
      const argsStr = JSON.stringify(call.args ?? {});
      if (argsStr.includes('dailymotion') || argsStr.includes('minecraft') || Object.keys((call.args as Record<string, unknown>) ?? {}).length > 0) {
        result.argsToolOk = true;
      }
    }
  } catch (err) {
    result.notes += `[Args tool: ${extractError(err)}] `;
  }

  // D. Tool loop completion
  if (toolResContent && toolCallName) {
    try {
      const t0 = performance.now();
      const loopReq: LlmInput = {
        system: 'Eres Botsky. Sintetiza una respuesta clara para el usuario basándote en el resultado técnico de la herramienta.',
        contents: [
          { role: 'user', parts: [{ text: 'oye el maicra sige bibo?' }] },
          toolResContent,
          {
            role: 'user',
            parts: [{
              functionResponse: {
                name: toolCallName,
                response: { online: true, players: 3, maxPlayers: 20, uptime: '3d 4h' },
                ...(toolCallId ? { id: toolCallId } : {}),
              },
            }],
          },
        ],
        tools: fullCatalogTools,
      };
      const loopRes = await adapter.generate(loopReq, model, apiKey, 'qualify-key');
      latencies.push(performance.now() - t0);
      if (loopRes.text && loopRes.text.trim().length > 0) {
        result.toolLoopCompleted = true;
      }
    } catch (err) {
      result.notes += `[Tool loop: ${extractError(err)}] `;
    }
  }

  result.latencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  result.fullCatalogCompatible = result.simpleToolOk && result.argsToolOk;
  result.agentCompatible = result.fullCatalogCompatible && result.toolLoopCompleted;

  if (result.agentCompatible) {
    result.qualifiedRole = isPrimaryCandidate ? 'primary' : 'fallback';
  } else if (result.chatCompatible) {
    result.qualifiedRole = 'chat_only';
  } else {
    result.qualifiedRole = 'none';
  }

  return result;
}

export async function runQualification(): Promise<QualificationResult[]> {
  const config = readConfig(process.env);
  const catalog = createToolRegistryV2(createRegistry());
  const fullCatalogTools = registryV2Declarations(catalog);

  console.log(`\n===============================================================`);
  console.log(`BOTSKY MULTI-PROVIDER LLM QUALIFICATION (Tools: ${fullCatalogTools.length})`);
  console.log(`===============================================================\n`);

  const results: QualificationResult[] = [];

  // Gemini Provider
  const geminiAdapter = new GeminiProvider(config.GEMINI_MODELS);
  const geminiKey = config.GEMINI_API_KEYS[0];
  for (let i = 0; i < config.GEMINI_MODELS.length; i++) {
    const model = config.GEMINI_MODELS[i]!;
    console.log(`Evaluating [gemini] ${model}...`);
    const r = await qualifyModel(geminiAdapter, model, geminiKey, fullCatalogTools, i === 0);
    results.push(r);
  }

  // Groq Provider
  const groqKey = config.GROQ_API_KEYS?.[0] || process.env.GROQ_API_KEY;
  const groqAdapter = new GroqProvider(config.GROQ_MODELS);
  for (const model of config.GROQ_MODELS) {
    console.log(`Evaluating [groq] ${model}...`);
    const r = await qualifyModel(groqAdapter, model, groqKey, fullCatalogTools, false);
    results.push(r);
  }

  // OpenRouter Provider
  const openRouterKey = config.OPENROUTER_API_KEYS?.[0] || process.env.OPENROUTER_API_KEY;
  const openRouterAdapter = new OpenRouterProvider(config.OPENROUTER_MODELS, config.OPENROUTER_ALLOW_FREE_MODELS);
  for (const model of config.OPENROUTER_MODELS) {
    console.log(`Evaluating [openrouter] ${model}...`);
    const r = await qualifyModel(openRouterAdapter, model, openRouterKey, fullCatalogTools, false);
    results.push(r);
  }

  // Print results table
  console.log(`\n### Empirical Model Qualification Matrix\n`);
  console.log(`| Provider | Model | Plain Chat | Simple Tool | Args Tool | Full Catalog | Loop Done | Latency | Agent Compat | Qualified Role | Notes |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);

  for (const r of results) {
    const chat = r.plainChatOk ? 'PASS' : (r.hasCredentials ? 'FAIL' : 'SKIPPED');
    const simple = r.simpleToolOk ? 'PASS' : (r.hasCredentials ? 'FAIL' : 'SKIPPED');
    const args = r.argsToolOk ? 'PASS' : (r.hasCredentials ? 'FAIL' : 'SKIPPED');
    const cat = r.fullCatalogCompatible ? 'PASS' : (r.hasCredentials ? 'FAIL' : 'SKIPPED');
    const loop = r.toolLoopCompleted ? 'PASS' : (r.hasCredentials ? 'FAIL' : 'SKIPPED');
    const lat = r.latencyMs ? `${r.latencyMs}ms` : '-';
    const agent = r.agentCompatible ? 'YES' : 'NO';
    console.log(`| ${r.provider} | ${r.model} | ${chat} | ${simple} | ${args} | ${cat} | ${loop} | ${lat} | ${agent} | **${r.qualifiedRole}** | ${r.notes || 'OK'} |`);
  }

  console.log(`\nSummary: Qualified ${results.filter(r => r.qualifiedRole !== 'none').length}/${results.length} models.\n`);
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('llm-qualify.ts')) {
  runQualification()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Qualification failed:', err);
      process.exit(1);
    });
}
