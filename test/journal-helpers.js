import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPgliteDb, createPgDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createJobRunner } from '../src/jobs.js';
import { ProviderError } from '../src/ai.js';
import { seedFamily, agent, jpeg, key, sub } from './helpers.js';

export const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`.replace(/\d/g, (d) => 'abcdefghij'[d])).join(' ');

// Mock provider: scripted per call. Each script item is an output object, an Error, or a function(img) -> output|throws.
export function mockProvider(script = []) {
  const calls = [];
  return {
    calls,
    script,
    async analyze(img) {
      calls.push(img);
      const next = script.length ? script.shift() : { transcript: words(60), illegible_count: 0, page_issues: [] };
      const v = typeof next === 'function' ? await next(img) : next;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
export const okOut = (n, extra = {}) => ({ transcript: words(n), illegible_count: 0, page_issues: [], ...extra });

export async function makeJournalEnv({ real = false, provider = mockProvider(), aiEnabled = true, mutate, clock, autoKick = false, pushDelayMs = 0 } = {}) {
  const config = loadConfig({ INSECURE_COOKIES: '1' });
  config.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:t@example.com' };
  config.ai.enabled = aiEnabled;
  config.ai.apiKey = 'test-key-not-real';
  config.ai.retryDelaySeconds = 0;
  mutate?.(config);
  const db = real ? await createPgDb({ databaseUrl: process.env.TEST_DATABASE_URL, dbSsl: false }) : await createPgliteDb();
  if (real) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const pushes = [];
  // pushDelayMs models a slow push service (as on a loaded CI runner): the push is recorded only after the delay.
  const pushSender = async (s, payload) => {
    if (pushDelayMs) await new Promise((r) => setTimeout(r, pushDelayMs));
    pushes.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  };
  const jobs = createJobRunner({ db, config, provider, pushSender, clock, log: { error() {} } });
  // Deterministic tests drive the runner by hand; the real kick-after-response path has its own test (autoKick: true).
  const driven = autoKick ? jobs : { ...jobs, kick() {} };
  const app = createApp({ db, config, pushSender, jobs: driven });
  const fam = await seedFamily(db, 'a');
  const other = await seedFamily(db, 'b');
  const up = agent(app), p1 = agent(app), p2 = agent(app);
  await up.login(fam.name('uploader')); await p1.login(fam.name('parent1')); await p2.login(fam.name('parent2'));
  await p1.post('/api/subscriptions').send(sub('https://web.push.apple.com/p1'));
  await p2.post('/api/subscriptions').send(sub('https://fcm.googleapis.com/fcm/send/p2'));
  return { db, config, app, jobs, provider, pushes, fam, other, up, p1, p2, pushSender };
}

// Bounded wait for an observable condition. Resolves as soon as cond() is truthy; throws once the deadline passes,
// so a condition that never becomes true still fails the test (the wait cannot turn a missing push into a pass).
export async function waitUntil(cond, { timeoutMs = 2000, intervalMs = 20, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const upload = async (a, k = key()) => a.post('/api/uploads').field('key', k).attach('photo', await jpeg(), 'p.jpg');
export const rowOf = async (db, uploadId) => (await db.query('SELECT * FROM journal_analyses WHERE upload_id = $1', [uploadId])).rows[0];
export const budget = async (db) => (await db.query('SELECT month, reserved_micro FROM ai_budget_months ORDER BY month')).rows;
export { ProviderError, crypto };
