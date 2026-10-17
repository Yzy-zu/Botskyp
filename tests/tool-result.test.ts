import { expect, it } from 'vitest';
import { z } from 'zod';
import { toolResultSchema, toolStatuses, type ToolResult } from '../src/core/tool-result.js';
const schema = toolResultSchema(z.strictObject({ count: z.number().int() }));
it.each(toolStatuses)('validates ToolResult status %s with typed data', status => {
  const value: ToolResult<{ count: number }> = { status, toolName: 'notes.search', domain: 'notes', code: 'found', data: { count: 2 } };
  expect(schema.parse(value)).toEqual(value);
});
it('rejects invented success states, invalid data, missing fields and arbitrary metadata', () => {
  const value = { status: 'ok', toolName: 'x', domain: 'notes', code: 'done', data: { count: 2 } };
  for (const bad of [{ ...value, status: 'success' }, { ...value, data: { count: '2' } }, { ...value, code: undefined }, { ...value, actorId: 'injected' }, { ...value, artifactProduced: 'fake' }]) {
    expect(schema.safeParse(bad).success).toBe(false);
  }
  expect(schema.parse({ ...value, requiresLlmSynthesis: true, artifactProduced: 'ea32e9f9-e313-44e4-996e-754d4c89d60b' })).toHaveProperty('requiresLlmSynthesis', true);
});
