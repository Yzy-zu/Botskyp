import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../src/core/registry.js';
import { alwaysOnBusinessTools, createToolRegistryV2, modelDeclaration, registryV2Declarations } from '../src/core/tool-registry-v2.js';
import { loadCapabilityMetaTool } from '../src/core/tool-exposure.js';
import { capabilityDomains } from '../src/core/capability-domain.js';
import { modelArgsSchemas } from '../src/core/model-args.js';

const legacy = createRegistry();
const catalog = createToolRegistryV2(legacy);
it('keeps the complete 98/96/2 business inventory and one separate meta-tool', () => {
  expect(catalog).toHaveLength(98);
  expect(catalog.filter(tool => tool.llmVisible)).toHaveLength(96);
  expect(catalog.filter(tool => !tool.llmVisible).map(tool => tool.name).sort()).toEqual(['bulk.confirm', 'school.schedule_commit']);
  expect(catalog.filter(tool => tool.exposure === 'internal')).toHaveLength(2);
  expect([loadCapabilityMetaTool]).toHaveLength(1);
  expect(catalog.map(tool => tool.name)).not.toContain(loadCapabilityMetaTool.name);
  expect(loadCapabilityMetaTool).not.toHaveProperty('permission');
  expect(loadCapabilityMetaTool).not.toHaveProperty('run');
  for (const tool of catalog) {
    expect(Object.keys(tool).sort()).toEqual(['name','domain','descriptionForModel','risk','llmVisible','exposure','permission','requiredModule','confirmationPolicy','modelArgsSchema','backendOnlyFields','presenter','requiresResultBeforeReply','supportsImmediateExecution','idempotencyStrategy','scope',...(tool.llmVisible?['capability']:['hiddenReason'])].sort());
    expect(capabilityDomains).toContain(tool.domain);
    expect(['READ','USER_WRITE','ECONOMIC','EXTERNAL','PRIVILEGED','DESTRUCTIVE']).toContain(tool.risk);
    expect(tool.requiresResultBeforeReply).toBe(true);
    expect(tool).not.toHaveProperty('run');
    expect(tool).not.toHaveProperty('execute');
  }
});
it('freezes every historical PermissionKey against the approved R1 snapshot (DEC-059)', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/v1.1/permissions-r1.json', import.meta.url), 'utf8')) as { decision: string; permissions: Record<string, string> };
  // A fixture update alone cannot authorize a permission change: add a new documented decision.
  const approvedDecisions: Record<string, string> = { 'DEC-059': '831b3ccda440f39c3f6d8827fd5f38f3dc6fc8d50c4d99bd09c236783ecaac70' };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(snapshot.permissions).sort(([a], [b]) => a.localeCompare(b))));
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(approvedDecisions[snapshot.decision]);
  expect(readFileSync(new URL('../docs/DECISIONES.md', import.meta.url), 'utf8')).toContain(`### ${snapshot.decision}:`);
  expect(Object.keys(snapshot.permissions)).toHaveLength(98);
  expect(Object.fromEntries(legacy.all().map(tool => [tool.name, tool.permission]))).toEqual(snapshot.permissions);
  expect(Object.fromEntries(catalog.map(tool => [tool.name, tool.permission]))).toEqual(snapshot.permissions);
  const byName = Object.fromEntries(catalog.map(tool => [tool.name, tool]));
  expect(byName['school.task_edit']?.permission).toBe('school.write');
  expect(byName['school.task_delete']).toMatchObject({ permission: 'school.manage', risk: 'DESTRUCTIVE' });
  expect(byName['minecraft.status']?.permission).toBe('minecraft.read');
  expect(byName['minecraft.players']?.permission).toBe('minecraft.read');
  for (const tool of catalog.filter(tool => tool.domain === 'minecraft' && !['minecraft.status', 'minecraft.players'].includes(tool.name))) expect(tool.permission).toBe('infra.minecraft');
});
it('declares exactly the seven always-on business tools', () => {
  expect(catalog.filter(tool => tool.exposure === 'always').map(tool => tool.name).sort()).toEqual([...alwaysOnBusinessTools].sort());
  expect(alwaysOnBusinessTools).toHaveLength(7);
});
it('translates exclusively modelArgsSchema, sanitizes all 98 contracts and rejects nested backend leaks', () => {
  const names = registryV2Declarations(catalog).map(tool => tool.name);
  expect(new Set(names).size).toBe(96);
  for (const tool of catalog) {
    if (!tool.llmVisible) {
      expect(() => modelDeclaration(tool)).toThrow('Internal tool');
      continue;
    }
    const declaration = modelDeclaration(tool);
    expect(declaration.name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
    expect(declaration.parametersJsonSchema).not.toHaveProperty('$schema');
    expect(JSON.stringify(declaration.parametersJsonSchema)).not.toMatch(/"(?:actorId|chatId|id|hash|previewHash|targetGroupId|filePath|role|dueAt|timezone)"/u);
    expect(JSON.stringify(declaration)).not.toMatch(/@(?:s\.whatsapp\.net|g\.us|lid)|\/home\/|\/data\//u);
    expect(declaration.description).toContain(`permission=${tool.permission}`);
    for (const key of tool.backendOnlyFields) expect(tool.modelArgsSchema.safeParse({ [key]: 'injected' }).success).toBe(false);
  }
  const tool = catalog[0]!;
  for (const field of ['actorId','chatId','JID','rawDbId','filesystemPath','roles','confirmationHash']) {
    expect(() => modelDeclaration({ ...tool, modelArgsSchema: z.strictObject({ nested: z.strictObject({ [field]: z.string() }) }) })).toThrow('Backend-only');
  }
});
it('requires scoped SafeRefs instead of raw IDs, and semantic times instead of model ISO dates', () => {
  expect(modelArgsSchemas['notes.edit'].safeParse({ noteRef: '123', body: 'hola' }).success).toBe(false);
  expect(modelArgsSchemas['notes.edit'].safeParse({ noteRef: 'noteRef_12345678-1234-1234-1234-123456789abc', body: 'hola' }).success).toBe(true);
  expect(modelArgsSchemas['school.destination'].safeParse({ targetGroupId: '123@g.us' }).success).toBe(false);
  expect(modelArgsSchemas['reminders.create'].safeParse({ body: 'hola', time: { kind: 'relative', amount: 2, unit: 'hour' } }).success).toBe(true);
  expect(modelArgsSchemas['reminders.create'].safeParse({ dueAt: '2026-10-18T12:00:00Z' }).success).toBe(false);
});
