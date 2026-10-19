import { QaRunner } from './runner.js';
import type { QaCase } from './types.js';

export const calibrationCases: QaCase[] = [
  {
    id: 'CAL-001',
    title: 'Natural conversation without tools or unrelated sessions',
    suite: 'calibration',
    mode: 'SAFE',
    turns: [
      {
        input: 'ola botsky',
        expectedTool: null,
      },
    ],
  },
  {
    id: 'CAL-002',
    title: 'Minecraft read tool with exact input args and no historical session',
    suite: 'calibration',
    mode: 'SAFE',
    turns: [
      {
        input: 'oye el maicra sige bibo?',
        expectedTool: 'minecraft.status',
        expectedPolicy: 'allow',
      },
    ],
  },
  {
    id: 'CAL-003',
    title: 'Video search on dailymotion with query and session creation',
    suite: 'calibration',
    mode: 'LIVE_SAFE',
    turns: [
      {
        input: 'botsky busca videos en dailymotion de minecraft',
        expectedTool: 'video.search',
        expectedPolicy: 'allow',
        expectedArgsPartial: { source: 'dailymotion' },
      },
    ],
  },
  {
    id: 'CAL-004',
    title: 'Multi-turn video search follow-up referencing turn 1 session',
    suite: 'calibration',
    mode: 'LIVE_SAFE',
    turns: [
      {
        input: 'botsky busca videos en dailymotion de minecraft',
        expectedTool: 'video.search',
      },
      {
        input: 'manda el segundo',
        quotePrevious: true,
      },
    ],
  },
];

async function main() {
  const runner = new QaRunner({ mode: 'SAFE' });
  console.log('=== RUNNING CALIBRATION ACCEPTANCE (CAL-001 to CAL-004) ===');

  try {
    for (const qaCase of calibrationCases) {
      console.log(`\n--------------------------------------------------`);
      console.log(`RUNNING ${qaCase.id}: ${qaCase.title} (${qaCase.mode})`);
      const result = await runner.runCase(qaCase);
      console.log(`RESULT ${qaCase.id}: status=${result.status}, terminalState=${result.terminalState}`);
      console.log(`  Inputs: ${JSON.stringify(result.inputs)}`);
      console.log(`  Tools: ${JSON.stringify(result.actualTools)}`);
      console.log(`  ToolCalls:`, JSON.stringify(result.toolCalls, null, 2));
      console.log(`  RelevantSession:`, JSON.stringify(result.relevantSession, null, 2));
      console.log(`  Jobs:`, JSON.stringify(result.jobs, null, 2));
      console.log(`  Outbox:`, JSON.stringify(result.outbox, null, 2));
      console.log(`  FinalResponse: ${result.finalResponse}`);
      if (result.errors.length > 0) {
        console.error(`  Errors:`, result.errors);
      }
    }
  } finally {
    await runner.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Calibration error:', err);
    process.exit(1);
  });
}
