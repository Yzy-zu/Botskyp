import { observer } from '../observer/index.js';
import pg from 'pg';
export function createDb(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
}
export type Db = pg.Pool;
export async function transaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); if(observer.ids().turnId || observer.ids().jobId)observer.emit({eventType:'TRANSACTION_STARTED',stage:'database'}); const result = await fn(client); await client.query('COMMIT');
    if(observer.clientIds(client).turnId || observer.ids().turnId || observer.ids().jobId)observer.emit({eventType:'TRANSACTION_COMMIT',stage:'database',...observer.clientIds(client)});
    if(observer.clientIds(client).inboxId && observer.clientIds(client).processing)observer.emit({eventType:'TURN_COMPLETED',stage:'inbox',...observer.clientIds(client),payload:{status:'processed'}});
    return result; }
  catch (err) {
    observer.emit({eventType:'TRANSACTION_ROLLBACK',stage:'database',...observer.clientIds(client),payload:{error:err,outcome:'rollback_requested'}});
    await client.query('ROLLBACK');
    observer.emit({eventType:'TRANSACTION_ROLLBACK',stage:'database',...observer.clientIds(client),payload:{outcome:'rolled_back'}});
    if(observer.clientIds(client).inboxId)observer.emit({eventType:'TURN_FAILED',stage:'inbox',...observer.clientIds(client),payload:{error:err,status:'rollback'}});
    throw err; }
  finally { observer.releaseClient(client);client.release(); }
}
