import type { PoolClient } from 'pg';
import { transaction } from '../db/client.js';
import type { ToolCtx } from './tools.js';

/** Inbox owns commit/rollback of effects, ledger and response together. Standalone callers own a fresh transaction. */
export function executionTransaction<T>(ctx: ToolCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return ctx.inboxTransaction ? fn(ctx.c) : transaction(ctx.db, fn);
}
