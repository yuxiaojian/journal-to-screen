// Spawns the REAL production entry point (`node src/server.js`) as a child process with a clean, explicit environment.
// The only addition is `--import net-fakes.mjs`, which redirects AI/push traffic to the local fakes and blocks all
// other egress. Nothing from src/ is imported by the test process.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
const NET_FAKES = path.join(here, 'net-fakes.mjs');

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// opts: { dbUrl, fakeUrl, vapid, ai: boolean, https: { appOrigin } | undefined, extraEnv }
export async function startServer(opts) {
  const port = opts.port || await freePort();
  const env = {
    PATH: process.env.PATH, // nothing else is inherited: no real keys, tokens or user config reach the server
    PORT: String(port),
    DATABASE_URL: opts.dbUrl,
    PGSSL: '0',
    VAPID_PUBLIC_KEY: opts.vapid.publicKey,
    VAPID_PRIVATE_KEY: opts.vapid.privateKey,
    VAPID_SUBJECT: 'mailto:bb-test@example.invalid',
    BB_FAKE_URL: opts.fakeUrl,
    ...(opts.https ? { APP_ORIGIN: opts.https.appOrigin } : { INSECURE_COOKIES: '1' }),
    ...(opts.ai ? { AI_ENABLED: '1', ANTHROPIC_API_KEY: 'bb-fake-key-not-a-secret' } : {}),
    ...(opts.extraEnv || {}),
  };
  const child = spawn(process.execPath, ['--import', NET_FAKES, 'src/server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const onData = (d) => { for (const line of d.toString('utf8').split('\n')) if (line) logs.push(line); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${logs.join('\n')}`)), 30_000);
    const check = () => {
      if (logs.some((l) => l.startsWith('listening on '))) { clearTimeout(t); resolve(); return true; }
      return false;
    };
    child.stdout.on('data', check);
    exited.then(({ code }) => { clearTimeout(t); reject(new Error(`server exited (${code}) before listening:\n${logs.join('\n')}`)); });
  });

  // DIAGNOSTIC ONLY (review round 1): probe the advertised address once, right after the listen line. On a refusal,
  // record who holds the port while the child is still alive, then fail. No retry, no change to allocation or timing.
  const probeAt = new Date().toISOString();
  const refused = await new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(null); });
    sock.on('error', (e) => resolve(e.code || String(e)));
  });
  if (refused) {
    const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return `(exit ${e.status}) ${e.stdout || ''}${e.stderr || ''}`; } };
    const report = {
      probeAt, port, error: refused, childPid: child.pid, childExitCode: child.exitCode, childSignal: child.signalCode,
      listenLine: logs.find((l) => l.startsWith('listening on ')), logs,
      lsofPort: sh('lsof', ['-nP', `-iTCP:${port}`]),
      lsofChild: sh('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP']),
      netstatPort: sh('sh', ['-c', `netstat -anv -p tcp | grep -E '[.:]${port} ' || true`]),
    };
    const dir = process.env.BB_DIAG_DIR || 'test-results';
    fs.mkdirSync(dir, { recursive: true });
    const file = `${dir}/bb-refused-${port}-${Date.now()}.json`;
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    child.kill('SIGKILL');
    throw new Error(`BB_DIAG: 127.0.0.1:${port} refused (${refused}) right after "listening"; diagnostics in ${file}`);
  }

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    logs,
    aiState: () => (logs.find((l) => l.startsWith('listening on ')) || '').split('ai=')[1],
    egressBlocked: () => logs.filter((l) => l.includes('net-fakes: blocked')),
    async kill(signal = 'SIGKILL') { if (child.exitCode === null && child.signalCode === null) child.kill(signal); await exited; },
  };
}

// Boots a server that is expected to refuse to start (config validation). Returns { code, logs }.
export async function startExpectingExit(opts) {
  const env = { PATH: process.env.PATH, PORT: String(await freePort()), BB_FAKE_URL: opts.fakeUrl, ...opts.env };
  const child = spawn(process.execPath, ['--import', NET_FAKES, 'src/server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  const code = await new Promise((r) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); r('timeout'); }, 15_000);
    child.once('exit', (c) => { clearTimeout(t); r(c); });
  });
  return { code, logs: logs.join('') };
}
