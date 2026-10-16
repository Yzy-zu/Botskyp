import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDb, transaction, type Db } from './client.js';
export async function migrate(db: Db): Promise<void> {
  // One connection owns the lock for the full migration sequence.
  await transaction(db, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-migrations'))");
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text primary key, checksum text not null, applied_at timestamptz default now())');
    const dir = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = await c.query<{checksum: string}>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (old.rows[0]) { if (old.rows[0].checksum !== checksum) throw new Error('Applied migration changed'); continue; }
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const db = createDb(url);
  try { await migrate(db); } finally { await db.end(); }
}
