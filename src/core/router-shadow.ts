import { buildTurnContextV2 } from './context-v2.js';
import pino from 'pino';
import type { ToolCtx } from './tools.js';
import type { Session } from './sessions.js';
import { moduleEnabled } from './permissions.js';
import type { ToolMetadataV2 } from './tool-registry-v2.js';
import { exactFastPathV2 } from './shortcuts-v2.js';
import { selectToolExposure, type ToolExposureInput } from './tool-exposure.js';

const log = pino({ level: 'info' });
export type ShadowSummary = {
  fastPathMatch: boolean; domains: readonly string[]; tools: readonly string[];
  approximateSchemaBytes: number;
};
/** Accepts data only: cannot query a DB, call Gemini or invoke handlers. */
export function calculateRouterShadow(catalog: readonly ToolMetadataV2[], input: ToolExposureInput): ShadowSummary {
  const exposure = selectToolExposure(catalog, input);
  return {
    fastPathMatch: exactFastPathV2(input.text) !== undefined,
    domains: exposure.selectedDomains, tools: exposure.toolNames,
    approximateSchemaBytes: exposure.approximateSchemaBytes,
  };
}
/** Reuses already-loaded v1 context. No new queries, artifact loaders or external calls in R2. */
export function observeRouterShadow(ctx: ToolCtx, session: Session | undefined, getCatalog: () => readonly ToolMetadataV2[]): ShadowSummary | undefined {
  if (ctx.config.ROUTER_MODE !== 'v1_1_shadow') return;
  try {
    const catalog = getCatalog();
    const attachment = ctx.msg.attachments[0];
    const summary = calculateRouterShadow(catalog, {
      text: ctx.msg.text, ...(ctx.msg.quoted?.text ? { quotedText: ctx.msg.quoted.text } : {}),
      actorRole: ctx.actor.role, chatType: ctx.chat.isGroup ? 'group' : 'private',
      enabledModules: [...new Set(catalog.map(tool => tool.requiredModule))].filter(module => moduleEnabled(ctx.chat, module, ctx.config)
        && (module !== 'minecraft' || ctx.config.MINECRAFT_ENABLED)
        && (module !== 'drive' || ctx.config.DRIVE_ENABLED)),
      ...(attachment ? { currentAttachment: { kind: attachment.kind, ...(attachment.mime ? { mime: attachment.mime } : {}) } } : {}),
      ...(session?.kind === 'game' ? { activeSession: { domain: 'games' as const }, activeGame: true } : {}),
      ...(session?.kind === 'media' ? { activeSession: { domain: 'media' as const } } : {}),
      ...(session?.kind === 'clarify' ? { activeSession: { domain: 'productivity' as const } } : {}),
    });
    // Fixed catalog names, booleans and sizes only. No text, IDs, arguments or session contents.
    log.info({ routerShadow: summary }, 'Router v1.1 shadow');
    return summary;
  } catch {
    // Shadow instrumentation must never change the response or transaction outcome.
    log.warn({ routerShadow: 'calculation_failed' }, 'Router v1.1 shadow');
  }
}

/** R4 observer uses SELECTs only. Savepoint isolates even a database error from the v1 transaction. */
export async function observeContextShadowV2(ctx: ToolCtx, domains: readonly string[]): Promise<void> {
  if (ctx.config.ROUTER_MODE !== 'v1_1_shadow' || !ctx.turnId) return;
  await ctx.c.query('SAVEPOINT context_shadow_v2');
  try {
    const context = await buildTurnContextV2(ctx, domains);
    log.info({ contextShadow: context.metrics }, 'Context v2 shadow');
    await ctx.c.query('RELEASE SAVEPOINT context_shadow_v2');
  } catch {
    await ctx.c.query('ROLLBACK TO SAVEPOINT context_shadow_v2');
    await ctx.c.query('RELEASE SAVEPOINT context_shadow_v2');
    log.warn({ contextShadow: 'calculation_failed' }, 'Context v2 shadow');
  }
}
