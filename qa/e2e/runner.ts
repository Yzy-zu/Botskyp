import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { readConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { buildEvolutionPayload, generateProviderMessageId } from './evolution-payload.js';
import { collectTurnResult, seedMediaFixture } from './result-collector.js';
import { smokeCases } from './cases/smoke.js';
import type {
  QaCase,
  QaCaseResult,
  QaMode,
  QaStatus,
  QaTurnResult,
  RunnerOptions,
} from './types.js';

function resolveDatabaseUrl(rawUrl: string): string {
  if (process.env.QA_DATABASE_URL) {
    return process.env.QA_DATABASE_URL;
  }
  if (rawUrl.includes('@botsky-db:')) {
    try {
      const containerIp = execSync(
        'docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" botsky-postgres-1 2>/dev/null',
        { encoding: 'utf8' }
      ).trim();
      if (containerIp) {
        return rawUrl.replace('@botsky-db:', `@${containerIp}:`);
      }
    } catch {
      // Docker command unavailable or running inside container
    }
  }
  return rawUrl;
}

export class QaRunner {
  private readonly config;
  private readonly db;
  private readonly targetUrl: string;
  private readonly secret: string;
  private readonly qaChatId: string;
  private readonly qaActorId: string;
  private readonly defaultMode: QaMode;
  private readonly outputDir: string;
  private readonly dryRun: boolean;

  constructor(options: RunnerOptions = {}) {
    if (existsSync('.env') && typeof (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile === 'function') {
      try {
        (process as unknown as { loadEnvFile: (path?: string) => void }).loadEnvFile('.env');
      } catch {
        // ignore if already loaded or unreadable
      }
    }

    this.dryRun = options.dryRun ?? false;
    this.config = readConfig();
    this.db = createDb(resolveDatabaseUrl(this.config.DATABASE_URL));
    this.targetUrl = options.targetUrl ?? process.env.WEBHOOK_TARGET ?? `http://127.0.0.1:${this.config.PORT}/webhook`;
    this.secret = options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? this.config.WEBHOOK_SECRET;
    this.qaChatId = options.qaChatId ?? process.env.QA_CHAT_ID ?? this.config.LAB_CHAT_ID;
    this.qaActorId = options.qaActorId ?? process.env.QA_ACTOR_ID ?? (this.config.OWNER_JIDS?.[0] ?? '5214435810175@s.whatsapp.net');
    this.defaultMode = options.mode ?? (process.env.QA_MODE as QaMode) ?? 'SAFE';
    this.outputDir = options.outputDir ?? join(process.cwd(), 'qa', 'e2e', 'reports');

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async close(): Promise<void> {
    await this.db.end();
  }

  loadCompletedCaseIds(jsonlPath: string): Set<string> {
    const completed = new Set<string>();
    if (!existsSync(jsonlPath)) return completed;
    const lines = readFileSync(jsonlPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { caseId?: string; status?: string };
        if (record.caseId && record.status === 'PASS') {
          completed.add(record.caseId);
        }
      } catch {
        // Ignore unparseable line
      }
    }
    return completed;
  }

  async runTurn(
    qaCase: QaCase,
    turnIndex: number,
    previousMessageId?: string
  ): Promise<QaTurnResult> {
    const turn = qaCase.turns[turnIndex]!;
    const providerMessageId = generateProviderMessageId(`E2E_${qaCase.id}_T${turnIndex + 1}`);
    const chatId = qaCase.chatId ?? this.qaChatId;
    const actorId = qaCase.actorId ?? this.qaActorId;

    // Hard security check: never send QA requests to non-lab chats
    if (chatId !== this.qaChatId && !chatId.endsWith('@g.us')) {
      throw new Error(`Security Violation: QA runner attempted to target non-QA chat ${chatId}`);
    }

    // Handle media attachments fixture seeding
    const attachments = turn.attachments ?? (turn.attachment ? [turn.attachment] : []);
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      if (att.fixturePath && existsSync(att.fixturePath)) {
        if (!this.dryRun) {
          await seedMediaFixture(this.db, chatId, actorId, providerMessageId, att.fixturePath, i);
        }
      }
    }

    // Build authentic Evolution v2.3.7 payload
    const payload = buildEvolutionPayload({
      instance: this.config.INSTANCE,
      providerMessageId,
      chatId,
      actorId,
      isGroup: qaCase.isGroup ?? chatId.endsWith('@g.us'),
      text: turn.input,
      attachments: attachments.length > 0 ? attachments : undefined,
      quoted: turn.quotePrevious && previousMessageId
        ? { stanzaId: previousMessageId, participant: actorId }
        : undefined,
    });

    if (this.dryRun) {
      console.log(`  [DRY RUN] Turn ${turnIndex + 1}: "${turn.input}" (ID: ${providerMessageId})`);
      return {
        turnIndex,
        providerMessageId,
        input: turn.input,
        httpStatus: 200,
        httpResponse: { dryRun: true },
        toolExecutions: [],
        session: null,
        jobs: [],
        outbox: [],
        llmUsage: [],
        finalText: '[DRY RUN PASS]',
        latencyMs: 0,
        status: 'SKIPPED',
        errors: [],
      };
    }

    // POST to real production webhook
    let httpStatus = 0;
    let httpResponse: unknown = null;
    try {
      const res = await fetch(this.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': this.secret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      httpStatus = res.status;
      try {
        httpResponse = await res.json();
      } catch {
        httpResponse = await res.text();
      }
    } catch (err: unknown) {
      httpStatus = 503;
      httpResponse = { error: err instanceof Error ? err.message : String(err) };
    }

    // Collect and correlate turn results from database
    return collectTurnResult(
      this.db,
      turnIndex,
      providerMessageId,
      chatId,
      actorId,
      turn.input,
      httpStatus,
      httpResponse,
      turn,
      { timeoutMs: 30000, pollIntervalMs: 500 }
    );
  }

  async runCase(qaCase: QaCase): Promise<QaCaseResult> {
    const started = Date.now();
    const turnResults: QaTurnResult[] = [];
    let overallStatus: QaStatus = 'PASS';
    let previousMsgId: string | undefined;

    for (let i = 0; i < qaCase.turns.length; i++) {
      const turnRes = await this.runTurn(qaCase, i, previousMsgId);
      turnResults.push(turnRes);
      previousMsgId = turnRes.providerMessageId;

      if (turnRes.status !== 'PASS' && turnRes.status !== 'SKIPPED') {
        overallStatus = turnRes.status;
        break; // Stop multi-turn continuation on failure
      }
      if (turnRes.status === 'SKIPPED' && overallStatus === 'PASS') {
        overallStatus = 'SKIPPED';
      }
    }

    const providerMessageIds = turnResults.map(t => t.providerMessageId);
    const turnIds = turnResults.map(t => t.turnId).filter((t): t is string => Boolean(t));
    const inputs = turnResults.map(t => t.input);
    const actualTools = turnResults.flatMap(t => t.toolExecutions.map(e => e.toolName));
    const args = turnResults.flatMap(t => t.toolExecutions.map(e => (e.resultJson?.data as Record<string, unknown>) ?? {}));
    const policy = turnResults.flatMap(t => t.toolExecutions.map(e => ({ tool: e.toolName, status: e.status })));
    const session = turnResults[turnResults.length - 1]?.session ?? null;
    const jobs = turnResults.flatMap(t => t.jobs);
    const outbox = turnResults.flatMap(t => t.outbox);
    const finalText = turnResults[turnResults.length - 1]?.finalText ?? null;
    const errors = turnResults.flatMap(t => t.errors);

    return {
      caseId: qaCase.id,
      title: qaCase.title,
      suite: qaCase.suite,
      mode: qaCase.mode ?? this.defaultMode,
      status: overallStatus,
      providerMessageIds,
      turnIds,
      inputs,
      actualTools,
      args,
      policy,
      session,
      jobs,
      outbox,
      finalText,
      latency: Date.now() - started,
      errors,
      turnResults,
      recordedAt: new Date().toISOString(),
    };
  }

  appendResult(result: QaCaseResult, jsonlPath: string): void {
    appendFileSync(jsonlPath, JSON.stringify(result) + '\n', 'utf8');
  }

  generateMarkdownReport(results: QaCaseResult[], mdPath: string): void {
    const total = results.length;
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const infraFailures = results.filter(r => r.status === 'INFRA_PROVIDER_FAILURE').length;
    const rateLimits = results.filter(r => r.status === 'RATE_LIMIT').length;

    let md = `# E2E QA Test Report — Botsky Webhook Harness\n\n`;
    md += `- **Generated:** ${new Date().toISOString()}\n`;
    md += `- **Target URL:** \`${this.targetUrl}\`\n`;
    md += `- **QA Chat:** \`${this.qaChatId}\`\n`;
    md += `- **Total Cases:** ${total}\n`;
    md += `- **Passed:** ${passed}\n`;
    md += `- **Failed:** ${failed}\n`;
    md += `- **Infra Failures:** ${infraFailures}\n`;
    md += `- **Rate Limits:** ${rateLimits}\n\n`;

    md += `## Case Results\n\n`;
    md += `| Case ID | Title | Mode | Status | Tools Executed | Latency | Errors |\n`;
    md += `|---|---|---|---|---|---|---|\n`;

    for (const r of results) {
      const err = r.errors.length > 0 ? r.errors.join('; ').replace(/\|/g, '\\|') : '-';
      const tools = r.actualTools.length > 0 ? r.actualTools.join(', ') : 'none';
      md += `| ${r.caseId} | ${r.title} | ${r.mode} | **${r.status}** | ${tools} | ${r.latency}ms | ${err} |\n`;
    }

    writeFileSync(mdPath, md, 'utf8');
  }

  async runSuite(cases: QaCase[], options: RunnerOptions = {}): Promise<QaCaseResult[]> {
    const jsonlPath = join(this.outputDir, 'qa-results.jsonl');
    const mdPath = join(this.outputDir, 'qa-report.md');
    const completedIds = options.resume ? this.loadCompletedCaseIds(jsonlPath) : new Set<string>();

    const results: QaCaseResult[] = [];

    for (const qaCase of cases) {
      if (options.caseId && qaCase.id !== options.caseId) {
        continue;
      }
      if (options.suite && qaCase.suite !== options.suite && options.suite !== 'all') {
        continue;
      }
      if (completedIds.has(qaCase.id)) {
        console.log(`[QA SKIP] ${qaCase.id} already passed (resume active).`);
        continue;
      }

      console.log(`\n[QA RUN] ${qaCase.id}: ${qaCase.title} (${qaCase.mode})...`);
      const result = await this.runCase(qaCase);
      results.push(result);
      this.appendResult(result, jsonlPath);
      console.log(`[QA RESULT] ${qaCase.id}: ${result.status} (${result.latency}ms) — Tools: [${result.actualTools.join(', ')}]`);
      if (result.errors.length > 0) {
        console.log(`            Errors: ${result.errors.join(', ')}`);
      }
    }

    this.generateMarkdownReport(results, mdPath);
    return results;
  }
}

// CLI Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const caseId = getArg('--case');
  const suite = getArg('--suite') ?? (caseId ? undefined : 'smoke');
  const mode = (getArg('--mode') as QaMode) ?? 'SAFE';
  const resume = args.includes('--resume');
  const dryRun = args.includes('--dry-run');

  const runner = new QaRunner({ mode, resume, dryRun });

  console.log('=== BOTSKY E2E BLACK-BOX QA RUNNER ===');
  console.log(`Target: http://127.0.0.1:3000/webhook`);
  console.log(`Mode: ${mode} | Suite: ${suite ?? 'all'} | Case: ${caseId ?? 'all'} | Resume: ${resume}`);

  runner
    .runSuite(smokeCases, { caseId, suite, mode, resume, dryRun })
    .then(results => {
      console.log(`\nCompleted ${results.length} cases.`);
      const passed = results.filter(r => r.status === 'PASS').length;
      console.log(`Passed: ${passed}/${results.length}`);
      return runner.close();
    })
    .catch(err => {
      console.error('Fatal Runner Error:', err);
      process.exit(1);
    });
}
