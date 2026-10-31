import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeContext, dryRun, smoke, pages } from '../scripts/validation/flows.js';
import { PromptCancelled } from '../scripts/validation/prompt.js';
import { MAX_CALLS, REPO_ROOT } from '../scripts/validation/guard.js';
import { SMOKE_TEXT } from '../scripts/validation/fixtures.js';
import { countWordsV1 } from '../src/journal.js';
import { settings, fakeNet, good, toolInput, fakeTty } from './validation-helpers.js';

const FAKE_KEY = 'sk-test-' + 'x'.repeat(32);

// A scripted "user at a terminal": answers are fed one prompt at a time, only when the program is waiting on stdin.
function scriptedTty(answers) {
  const tty = fakeTty();
  const queue = [...answers];
  const out = { chunks: [], write(x) { this.chunks.push(String(x)); if (queue.length && /[:?\]] $/.test(String(x))) setImmediate(() => tty.write(queue.shift())); return true; } };
  tty.out = out; tty.remaining = () => queue.length;
  return tty;
}
const ctx = ({ answers, net }) => {
  const tty = scriptedTty(answers);
  const lines = [];
  const c = makeContext({ settings, io: { input: tty, output: tty.out }, realFetch: net, out: (s) => lines.push(s) });
  return { c, tty, lines, text: () => lines.join('\n') };
};

test('dry run: no key requested, no network, prints the production request summary and the derived expected count', async () => {
  const net = fakeNet([]);
  const { c, tty, text } = ctx({ answers: [], net });
  await dryRun(c);
  assert.equal(net.calls.length, 0);
  assert.equal(tty.rawCalls.length, 0); // never touched the terminal
  assert.match(text(), /DRY RUN: offline/);
  assert.match(text(), new RegExp(`smoke fixture expected count_v1 = ${countWordsV1(SMOKE_TEXT.lines.join('\n'))}`));
  assert.match(text(), /NOT a provider-enforced cap/);
  assert.match(text(), /one consented session; a restart requires fresh consent/);
});

test('smoke: key -> yes -> per-call confirmation; two calls, numbers on screen, key never printed', async () => {
  const net = fakeNet([good(toolInput(19)), good({ transcript: '', illegible_count: 0, page_issues: ['blank'] })]);
  const { c, tty, text } = ctx({ answers: [`${FAKE_KEY}\r`, 'yes\r', 'y\r', 'y\r'], net });
  const { session } = await smoke(c);
  assert.equal(net.calls.length, 2);
  assert.equal(session.used, 2);
  assert.equal(net.calls[0].init.redirect, 'error');
  assert.equal(net.calls[0].init.headers['x-api-key'], FAKE_KEY); // the key is used only as the request header
  assert.ok(!text().includes(FAKE_KEY), 'the key must never be printed');
  assert.ok(!tty.out.chunks.join('').includes(FAKE_KEY), 'nor echoed to the terminal');
  assert.ok(!JSON.stringify(session.log).includes(FAKE_KEY));
  assert.match(text(), /smoke: count=19/);
  assert.match(text(), /blank: count=0 minutes=0 status=needs_review/);
  assert.equal(tty.isRaw, false);
});

test('smoke: declining consent sends nothing; declining a per-call confirmation stops with the slot unused', async () => {
  const n1 = fakeNet([good()]);
  const a = ctx({ answers: [`${FAKE_KEY}\r`, 'no\r'], net: n1 });
  await smoke(a.c);
  assert.equal(n1.calls.length, 0);
  assert.match(a.text(), /No consent/);
  const n2 = fakeNet([good(), good()]);
  const b = ctx({ answers: [`${FAKE_KEY}\r`, 'yes\r', 'n\r'], net: n2 });
  const { session } = await smoke(b.c);
  assert.equal(n2.calls.length, 0);
  assert.equal(session.used, 0);
  assert.match(b.text(), /Stopped by owner/);
});

test('smoke: cancelling at the key prompt (Ctrl-C) restores the terminal and sends nothing', async () => {
  const net = fakeNet([good()]);
  const { c, tty } = ctx({ answers: ['\u0003'], net });
  await assert.rejects(smoke(c), PromptCancelled);
  assert.equal(net.calls.length, 0);
  assert.equal(tty.isRaw, false);
});

test('smoke: a non-TTY refuses before asking for anything', async () => {
  const tty = fakeTty({ isTTY: false });
  const c = makeContext({ settings, io: { input: tty, output: { write() {} } }, realFetch: fakeNet([good()]), out: () => {} });
  await assert.rejects(smoke(c), /tty_required/);
  assert.deepEqual(tty.rawCalls, []);
});

test('smoke: malformed keys are rejected before consent or any call', async () => {
  for (const bad of ['\r', 'short\r', 'has spaces in the key value here 12345\r']) {
    const net = fakeNet([good()]);
    const { c } = ctx({ answers: [bad], net });
    await assert.rejects(smoke(c), /key_format/);
    assert.equal(net.calls.length, 0);
  }
});

test('smoke: a failed or ambiguous call stops the session, keeps its slot, and is never retried', async () => {
  for (const failure of [Object.assign(new Error('x'), { name: 'AbortError' }), { status: 503, ok: false, json: async () => ({}) }]) {
    const net = fakeNet([failure, good()]);
    const { c, text } = ctx({ answers: [`${FAKE_KEY}\r`, 'yes\r', 'y\r', 'y\r'], net });
    const { session } = await smoke(c);
    assert.equal(net.calls.length, 1);
    assert.equal(session.used, 1);
    assert.match(text(), /FAILED/);
    assert.match(text(), /no automatic retry/);
  }
});

test('smoke: an over-bound usage reading stops the session before the second call', async () => {
  const net = fakeNet([good(toolInput(19), { usage: { input_tokens: 999999, output_tokens: 10 } }), good()]);
  const { c, text } = ctx({ answers: [`${FAKE_KEY}\r`, 'yes\r', 'y\r', 'y\r'], net });
  const { session } = await smoke(c);
  assert.equal(net.calls.length, 1);
  assert.equal(session.stopped, 'input_over_bound');
  assert.match(text(), /Stopped before blank: input_over_bound/);
});

// ---------- the five private pages ----------
function makePages(n = 5, { withRefs = true, mode = 0o700 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-pages-'));
  fs.chmodSync(dir, mode);
  for (let i = 1; i <= n; i += 1) {
    fs.writeFileSync(path.join(dir, `p${i}.jpg`), Buffer.from('FFD8FFE0', 'hex')); // not decoded unless a live call prepares it; see below
    if (withRefs) fs.writeFileSync(path.join(dir, `p${i}.txt`), Array.from({ length: 50 + i }, () => 'word').join(' '));
  }
  return dir;
}
async function realJpegs(dir) {
  const sharp = (await import('sharp')).default;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    fs.writeFileSync(path.join(dir, f), await sharp({ create: { width: 400, height: 300, channels: 3, background: '#eee' } }).jpeg().toBuffer());
  }
}
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'val-res-'));

test('pages: refuses a page directory inside the repo, a group-readable one, a wrong page count, and missing references -- before asking for a key', async () => {
  const mk = () => ctx({ answers: [], net: fakeNet([good()]) }).c;
  await assert.rejects(pages(mk(), { dir: path.join(REPO_ROOT, 'scripts'), results: path.join(outDir(), 'r.json'), repoRoot: REPO_ROOT }), /path_inside_repo/);
  await assert.rejects(pages(mk(), { dir: makePages(5, { mode: 0o755 }), results: path.join(outDir(), 'r.json'), repoRoot: REPO_ROOT }), /dir_not_private/);
  await assert.rejects(pages(mk(), { dir: makePages(4), results: path.join(outDir(), 'r.json'), repoRoot: REPO_ROOT }), /need_exactly_five_pages/);
  await assert.rejects(pages(mk(), { dir: makePages(5, { withRefs: false }), results: path.join(outDir(), 'r.json'), repoRoot: REPO_ROOT }), /missing_reference_1/);
  await assert.rejects(pages(mk(), { dir: makePages(5), results: path.join(REPO_ROOT, 'r.json'), repoRoot: REPO_ROOT }), /path_inside_repo/);
});

test('pages: reference counts are fixed and shown BEFORE the key prompt and before any model output', async () => {
  const dir = makePages(5); await realJpegs(dir);
  const net = fakeNet([]);
  const { c, lines } = ctx({ answers: ['\u0003'], net });
  await assert.rejects(pages(c, { dir, results: path.join(outDir(), 'r.json'), repoRoot: REPO_ROOT }), PromptCancelled);
  const joined = lines.join('\n');
  assert.match(joined, /Reference counts fixed before any model call: 51, 52, 53, 54, 55/);
  assert.equal(net.calls.length, 0);
});

test('pages: full run writes numeric/boolean evidence only (no text, no filenames), mode 600, outside the repo; and never overwrites', async () => {
  const dir = makePages(5); await realJpegs(dir);
  const res = path.join(outDir(), 'result.json');
  const script = Array.from({ length: 5 }, (_, i) => good({ transcript: Array.from({ length: 51 + i }, () => 'SECRETWORD').join(' '), illegible_count: 0, page_issues: [] }));
  const answers = [`${FAKE_KEY}\r`, 'yes\r'];
  for (let i = 0; i < 5; i += 1) answers.push('y\r', 'y\r', 'n\r'); // send, clear, not invented
  const { c, text } = ctx({ answers, net: fakeNet(script) });
  const { results, gate, session } = await pages(c, { dir, results: res, repoRoot: REPO_ROOT });
  assert.equal(session.used, 5);
  assert.equal(results.length, 5);
  assert.equal(gate.passed, true);
  const saved = fs.readFileSync(res, 'utf8');
  assert.ok(!saved.includes('SECRETWORD'), 'model text must never be saved');
  assert.ok(!saved.includes('p1.jpg') && !saved.includes(dir), 'filenames and paths must never be saved');
  assert.ok(!saved.includes(FAKE_KEY));
  const ev = JSON.parse(saved);
  for (const p of ev.pages) for (const [k, v] of Object.entries(p)) assert.ok(['number', 'boolean'].includes(typeof v) || v === null, `${k}: ${typeof v}`);
  assert.equal(ev.callsReserved, 5);
  assert.equal(fs.statSync(res).mode & 0o777, 0o600);
  assert.ok(text().includes('SECRETWORD'), 'the model text is shown on screen for the owner to judge');
  // a second run to the same results path must fail rather than overwrite
  const again = ctx({ answers, net: fakeNet(script.map(() => good())) });
  await assert.rejects(pages(again.c, { dir, results: res, repoRoot: REPO_ROOT }), /EEXIST/);
});

test('pages: the gate FAILS when the owner reports an invented passage on an accepted page', async () => {
  const dir = makePages(5); await realJpegs(dir);
  const res = path.join(outDir(), 'r.json');
  const script = Array.from({ length: 5 }, (_, i) => good({ transcript: Array.from({ length: 51 + i }, () => 'w').join(' '), illegible_count: 0, page_issues: [] }));
  const answers = [`${FAKE_KEY}\r`, 'yes\r'];
  for (let i = 0; i < 5; i += 1) answers.push('y\r', 'y\r', i === 2 ? 'y\r' : 'n\r');
  const { c } = ctx({ answers, net: fakeNet(script) });
  const { gate } = await pages(c, { dir, results: res, repoRoot: REPO_ROOT });
  assert.equal(gate.inventedOnAccepted, 1);
  assert.equal(gate.passed, false);
});

test('pages: a stopped session (bad usage) ends the run; evidence still records only the pages completed and is not a pass', async () => {
  const dir = makePages(5); await realJpegs(dir);
  const res = path.join(outDir(), 'r.json');
  const script = [good({ transcript: Array.from({ length: 51 }, () => 'w').join(' '), illegible_count: 0, page_issues: [] }, { usage: { input_tokens: 10 ** 7, output_tokens: 5 } }), good()];
  const answers = [`${FAKE_KEY}\r`, 'yes\r', 'y\r', 'y\r', 'n\r'];
  const { c } = ctx({ answers, net: fakeNet(script) });
  const { gate, session } = await pages(c, { dir, results: res, repoRoot: REPO_ROOT });
  assert.equal(session.stopped, 'input_over_bound');
  assert.equal(gate.pages, 1);
  assert.equal(gate.passed, false);
  assert.equal(JSON.parse(fs.readFileSync(res, 'utf8')).stopped, 'input_over_bound');
});

test('nothing in the CLI or flows can redirect the network, the endpoint, the model or the limits', () => {
  const files = ['scripts/validate.js', 'scripts/validation/flows.js', 'scripts/validation/guard.js', 'scripts/validation/runner.js', 'scripts/validation/prompt.js'];
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/process\.env\.(ANTHROPIC|HTTPS?_PROXY|NODE_TLS|NODE_OPTIONS|BASE)/i.test(src), `${f} reads an env override`);
    assert.ok(!/--(endpoint|url|model|base|proxy|max-calls|calls)\b/.test(src.replace(/KNOWN = new Set\([^)]*\)/, '')), `${f} exposes an override flag`);
    // The key variable may be passed to the provider and the hidden prompt, but never interpolated into any output call.
    const outputs = [...src.matchAll(/(?:console\.(?:log|error)|c\.out|out)\(([^;]*)\);/g)].map((m) => m[1]);
    for (const o of outputs) assert.ok(!/\$\{[^}]*\b(key|apiKey)\b[^}]*\}/.test(o) && !/[^'"`\w]key\)/.test(o), `${f} may output the key: ${o.slice(0, 60)}`);
  }
  const cli = fs.readFileSync(new URL('../scripts/validate.js', import.meta.url), 'utf8');
  assert.match(cli, /a key must never be passed as an argument/);
  assert.match(cli, /KNOWN = new Set\(\['--smoke', '--pages', '--results', '--injection', '--help'\]\)/);
});
