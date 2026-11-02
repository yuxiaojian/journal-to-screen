// Executable canaries for the suite's own isolation. These run on every suite run (locally and in CI) and need no
// network: each forbidden attempt must be refused before any packet leaves, and a non-loopback database URL must be
// refused before the PostgreSQL client is ever asked to connect.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const NET_FAKES = path.join(here, 'harness', 'net-fakes.mjs');

function run(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: REPO, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Each attempt targets a reserved, non-routable name or a documentation address, so even a guard failure could not
// reach a real service; the canary records whether the attempt was refused synchronously by the guard.
const EGRESS_CANARY = `
const net = require('node:net'), tls = require('node:tls'), https = require('node:https'), http = require('node:http'), dgram = require('node:dgram');
const results = {};
const attempt = async (name, fn) => {
  try { await fn(); results[name] = 'NOT_BLOCKED'; }
  catch (e) { results[name] = e && e.code === 'BB_EGRESS_BLOCKED' ? 'blocked' : 'other:' + (e && e.code); }
};
(async () => {
  await attempt('fetch', () => fetch('https://canary.example.invalid/'));
  await attempt('https.request', () => https.request({ hostname: 'canary.example.invalid', port: 443 }).on('error', () => {}));
  await attempt('https.get', () => https.get('https://canary.example.invalid/').on('error', () => {}));
  await attempt('http.request', () => http.request({ hostname: '192.0.2.10', port: 80 }).on('error', () => {}));
  await attempt('net.connect', () => net.connect(443, '192.0.2.10').on('error', () => {}));
  await attempt('net.createConnection', () => net.createConnection({ host: 'canary.example.invalid', port: 443 }).on('error', () => {}));
  await attempt('new net.Socket().connect(port, host)', () => new net.Socket().connect(443, '192.0.2.10').on('error', () => {}));
  await attempt('new net.Socket().connect(options)', () => new net.Socket().connect({ host: 'canary.example.invalid', port: 443 }).on('error', () => {}));
  await attempt('tls.connect', () => tls.connect({ host: 'canary.example.invalid', port: 443 }).on('error', () => {}));
  await attempt('dgram.send', () => { const s = dgram.createSocket('udp4'); try { s.send('x', 53, '192.0.2.10'); } finally { s.close(); } });
  const lo = new net.Socket(); lo.on('error', () => {});
  try { lo.connect(9, '127.0.0.1'); results['loopback'] = 'allowed'; } catch (e) { results['loopback'] = 'blocked'; }
  lo.destroy();
  console.log('RESULTS ' + JSON.stringify(results));
  process.exit(0);
})();
`;

// Replaces pg.Client#connect with a sentinel BEFORE the harness is loaded: if anything asks the client to connect,
// the canary records CONTACTED. No real connection is ever possible in this process.
const pgContactCanary = (body) => `
import pg from 'pg';
let contacted = 0;
pg.Client.prototype.connect = async function () { contacted += 1; throw new Error('sentinel: connect called'); };
const out = {};
${body}
console.log('RESULTS ' + JSON.stringify({ ...out, contacted }));
`;

const results = (r) => JSON.parse(r.out.split('RESULTS ')[1].split('\n')[0]);

test.describe('suite isolation guards', () => {
  test('every outbound network API is refused by the server-side guard; loopback still works', async () => {
    const r = run(['--import', NET_FAKES, '-e', EGRESS_CANARY], { BB_FAKE_URL: 'http://127.0.0.1:9' });
    expect(r.code, r.out).toBe(0);
    const res = results(r);
    expect(res.loopback).toBe('allowed');
    const outbound = Object.entries(res).filter(([k]) => k !== 'loopback');
    expect(outbound.length).toBe(10);
    for (const [name, outcome] of outbound) expect(outcome, name).toBe('blocked');
  });

  test('the guard refuses to load unless its fake service is on 127.0.0.1', async () => {
    for (const fake of ['', 'http://10.0.0.1:9', 'http://localhost.example:9', 'https://127.0.0.1:9']) {
      const r = run(['--import', NET_FAKES, '-e', 'console.log("STARTED")'], { BB_FAKE_URL: fake });
      expect(r.code, `BB_FAKE_URL=${fake}`).toBe(97);
      expect(r.out).not.toContain('STARTED');
    }
  });

  test('a non-loopback database URL is refused before any connection is attempted', async () => {
    const bad = [
      'postgres://u:p@db.example.invalid:5432/postgres',
      'postgres://u:p@192.0.2.10/postgres',
      'postgres://u:p@127.0.0.1/postgres?host=db.example.invalid',
      'postgres://u:p@127.0.0.1.example.invalid/postgres',
      'mysql://u:p@127.0.0.1/x',
      'not a url',
    ];
    const r = run(['--input-type=module', '-e', pgContactCanary(`
      const { createDb, dropDb, withDb, serverVersion } = await import('./test-bb/harness/pg.mjs');
      const setup = (await import('./test-bb/harness/global-setup.mjs')).default;
      for (const url of ${JSON.stringify(bad)}) {
        for (const [name, fn] of Object.entries({
          createDb: () => createDb(url), dropDb: () => dropDb(url, 'bb_x'), withDb: () => withDb(url, async () => 0),
          serverVersion: () => serverVersion(url),
          globalSetup: () => { process.env.BB_PG_URL = url; return setup(); },
        })) {
          try { await fn(); out[name + ' ' + url] = 'ACCEPTED'; } catch (e) { out[name + ' ' + url] = /refusing/.test(e.message) ? 'refused' : 'other: ' + e.message; }
        }
      }
    `)]);
    expect(r.code, r.out).toBe(0);
    const res = results(r);
    expect(res.contacted, 'pg.Client#connect must never be called').toBe(0);
    const entries = Object.entries(res).filter(([k]) => k !== 'contacted');
    expect(entries.length).toBe(bad.length * 5);
    for (const [k, v] of entries) expect(v, k).toBe('refused');
  });

  test('test:all refuses a non-loopback unit or black-box database URL before running anything', async () => {
    const script = path.join('test-bb', 'harness', 'check-local-urls.mjs');
    expect(run([script], { TEST_DATABASE_URL: 'postgres://u:p@db.example.invalid/unit' }).code).toBe(1);
    expect(run([script], { BB_PG_URL: 'postgres://u:p@192.0.2.10/postgres' }).code).toBe(1);
    expect(run([script], { BB_PG_URL: 'postgres://u:p@127.0.0.1:5432/postgres', TEST_DATABASE_URL: 'postgres://u:p@localhost:5432/unit' }).code).toBe(0);
    expect(run([script]).code).toBe(0);
    // and test:all runs this check first, before the unit suite touches TEST_DATABASE_URL
    const pkg = JSON.parse((await import('node:fs')).readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:all'].startsWith('node test-bb/harness/check-local-urls.mjs && ')).toBe(true);
  });

  test('server ports come from per-worker blocks below the OS ephemeral range; overlap and exhaustion fail clearly', async () => {
    const ports = await import('./harness/ports.mjs');
    const r = ports.assertOutsideEphemeral(); // this machine
    expect(r.blocks[1]).toBeLessThan(r.ephemeral.first);
    const blocks = Array.from({ length: ports.MAX_WORKERS }, (_, i) => ports.workerBlock(i));
    for (let i = 1; i < blocks.length; i += 1) expect(blocks[i].first).toBe(blocks[i - 1].last + 1); // contiguous, no overlap
    expect(() => ports.workerBlock(ports.MAX_WORKERS)).toThrow(/worker index/);
    expect(() => ports.assertOutsideEphemeral({ first: 20100, last: 30000, source: 'test' })).toThrow(/overlap the OS ephemeral range/);
    const p = await ports.nextPort();
    const mine = ports.workerBlock();
    expect(p).toBeGreaterThanOrEqual(mine.first);
    expect(p).toBeLessThanOrEqual(mine.last);
  });

  test('fake VAPID keys are always a valid fixed-width pair, including scalars with leading zero bytes', async () => {
    const crypto = await import('node:crypto');
    const { default: webpush } = await import('web-push');
    const { makeVapidKeys } = await import('./harness/webpush-decrypt.mjs');
    // The exact edge case that broke main CI run 41384287192: a private scalar whose first byte is zero (Node then
    // returns 31 bytes), plus two leading zeros (30 bytes).
    for (const zeros of [1, 2]) {
      const sk = crypto.randomBytes(32);
      sk.fill(0, 0, zeros);
      sk[zeros] |= 1;
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(sk);
      expect(ecdh.getPrivateKey().length).toBe(32 - zeros); // the raw Node behaviour this guards against
      const k = makeVapidKeys({ privateScalar: sk });
      expect(Buffer.from(k.privateKey, 'base64url')).toEqual(sk);
      expect(Buffer.from(k.publicKey, 'base64url').length).toBe(65);
      expect(() => webpush.setVapidDetails('mailto:bb@example.invalid', k.publicKey, k.privateKey)).not.toThrow();
      // and the pair matches: the public key derives from the padded private key
      const check = crypto.createECDH('prime256v1');
      check.setPrivateKey(Buffer.from(k.privateKey, 'base64url'));
      expect(check.getPublicKey().toString('base64url')).toBe(k.publicKey);
    }
    // many random pairs, all accepted
    for (let i = 0; i < 2000; i += 1) {
      const k = makeVapidKeys();
      expect(Buffer.from(k.privateKey, 'base64url').length).toBe(32);
      expect(() => webpush.setVapidDetails('mailto:bb@example.invalid', k.publicKey, k.privateKey)).not.toThrow();
    }
  });
});
