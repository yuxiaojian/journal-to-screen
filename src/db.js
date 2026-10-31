// Tiny DB seam: { query(text, params), tx(fn), exec(sql), close() }.
// Production uses pg; tests use in-process PGlite. Same SQL for both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function createPgDb(config) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined, // Heroku PG uses a self-signed chain
    max: 5,
  });
  return {
    query: (t, p) => pool.query(t, p),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: (t, p) => c.query(t, p) });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  return {
    query: (t, p) => pg.query(t, p),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
    close: () => pg.close(),
  };
}

export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
}
