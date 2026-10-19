import type { QaCase } from '../types.js';

export const smokeCases: QaCase[] = [
  {
    id: 'SMOKE-001',
    title: 'Natural greeting and liveness check',
    suite: 'smoke',
    mode: 'SAFE',
    turns: [
      {
        input: 'hola botsky, ¿estás despierto?',
        expectedStatus: 'ok',
      },
    ],
  },
  {
    id: 'SMOKE-002',
    title: 'Natural capability query (core.help)',
    suite: 'smoke',
    mode: 'SAFE',
    turns: [
      {
        input: 'botsky qué funciones tienes disponibles',
        expectedTool: 'core.help',
        expectedStatus: 'ok',
      },
    ],
  },
  {
    id: 'SMOKE-003',
    title: 'Live safe web search (web.search)',
    suite: 'smoke',
    mode: 'LIVE_SAFE',
    turns: [
      {
        input: 'busca información reciente sobre la misión Artemis de la NASA',
        expectedTool: 'web.search',
        expectedStatus: 'ok',
      },
    ],
  },
  {
    id: 'SMOKE-004',
    title: 'Destructive action blocked by confirmation gate in SAFE mode',
    suite: 'smoke',
    mode: 'SAFE',
    turns: [
      {
        input: 'borra la nota sobre el proyecto',
        expectedStatus: 'needs_confirmation',
      },
    ],
  },
  {
    id: 'SMOKE-005',
    title: 'Video search parity on Dailymotion',
    suite: 'smoke',
    mode: 'LIVE_SAFE',
    turns: [
      {
        input: 'busca videos en dailymotion de documentales de naturaleza cortos',
        expectedTool: 'video.search',
        expectedStatus: 'ok',
      },
    ],
  },
];
