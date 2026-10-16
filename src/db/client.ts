import pg from 'pg';
export function createDb(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
}
export type Db = pg.Pool;
export async function transaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
