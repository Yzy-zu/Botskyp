import { QaRunner } from './runner.js';
import type { QaCase } from './types.js';

export const auditSafeCase: QaCase = {
  id: 'AUDIT-SAFE-001',
  title: 'Destructive action in SAFE mode with required terminal outbox',
  suite: 'audit',
  mode: 'SAFE',
  turns: [
    {
      input: 'apaga minecraft',
      expectedStatus: 'needs_confirmation',
    },
    {
      input: 'sí',
      quotePrevious: true,
      expectedStatus: 'qa_suppressed',
    },
  ],
};

async function main() {
  const runner = new QaRunner({ mode: 'SAFE' });
  console.log('=== RUNNING AUDIT-SAFE-001 ===');
  try {
    const result = await runner.runCase(auditSafeCase);
    console.log(`RESULT: status=${result.status}, terminalState=${result.terminalState}`);
    console.log(`  Tools:`, result.actualTools);
    console.log(`  ToolCalls:`, JSON.stringify(result.toolCalls, null, 2));
    console.log(`  Outbox:`, JSON.stringify(result.outbox, null, 2));
    console.log(`  FinalResponse:`, result.finalResponse);
    if (result.errors.length > 0) {
      console.error(`  Errors:`, result.errors);
    }
  } finally {
    await runner.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Audit error:', err);
    process.exit(1);
  });
}
