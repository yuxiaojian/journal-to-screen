// Real PostgreSQL for the black-box suite. Either an existing server (BB_PG_URL, e.g. the CI service container) or a
// throwaway postgres:18 Docker container bound to 127.0.0.1 with tmpfs storage. One fresh database per test.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertLoopbackPgUrl } from './local-url.mjs';

export const PG_IMAGE = 'postgres:18';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitReady(url, ms = 60_000) {
  assertLoopbackPgUrl(url);
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      last = e;
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`postgres not ready: ${last?.message}`);
}

// Starts a container and returns { url, name }. The password is random per run and never leaves this machine.
export async function startDockerPg() {
  try { sh('docker', ['info', '--format', '{{.ServerVersion}}']); } catch {
    throw new Error('Docker is required for the local black-box run (or set BB_PG_URL to an existing PostgreSQL 18)');
  }
  const name = `bb-pg-${crypto.randomBytes(4).toString('hex')}`;
  const pw = crypto.randomBytes(12).toString('hex');
  sh('docker', ['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${pw}`, '-p', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql:rw', PG_IMAGE]);
  const port = sh('docker', ['port', name, '5432/tcp']).split('\n')[0].split(':').pop();
  const url = `postgres://postgres:${pw}@127.0.0.1:${port}/postgres`;
  await waitReady(url);
  return { url, name };
}

export function stopDockerPg(name) {
  if (name) { try { sh('docker', ['rm', '-f', name]); } catch { /* already gone */ } }
}

const dbUrl = (adminUrl, db) => { const u = new URL(adminUrl); u.pathname = `/${db}`; return u.toString(); };

export async function createDb(adminUrl) {
  assertLoopbackPgUrl(adminUrl, 'BB_PG_URL');
  const db = `bb_${crypto.randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(`CREATE DATABASE ${db}`); } finally { await c.end(); }
  return { name: db, url: dbUrl(adminUrl, db) };
}

export async function dropDb(adminUrl, name) {
  assertLoopbackPgUrl(adminUrl, 'BB_PG_URL');
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
}

// Fixture-only SQL (setup/preconditions). Assertions never read the database.
export async function withDb(url, fn) {
  assertLoopbackPgUrl(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

export async function serverVersion(url) {
  assertLoopbackPgUrl(url, 'BB_PG_URL');
  return withDb(url, async (c) => (await c.query('SHOW server_version')).rows[0].server_version);
}
