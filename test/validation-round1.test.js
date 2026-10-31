import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { makeContext, smoke, pages } from '../scripts/validation/flows.js';
import { gateResult, liveCall } from '../scripts/validation/runner.js';
import { REPO_ROOT } from '../scripts/validation/guard.js';
import { expectSmoke, expectBlank, expectInjection, SMOKE_TEXT, INJECTION_TEXT, normalizeLiteral } from '../scripts/validation/fixtures.js';
import { askHidden, PromptCancelled, PROMPT_SIGNALS } from '../scripts/validation/prompt.js';
import { countWordsV1 } from '../src/journal.js';
import { settings, bounds, newSession, fakeNet, good, toolInput, fakeTty, sink } from './validation-helpers.js';

const KEY = 'sk-test-' + 'x'.repeat(32);
const SMOKE_LIT = SMOKE_TEXT.lines.join('\n');
const INJ_LIT = INJECTION_TEXT.lines.join('\n');
const out = (transcript, extra = {}) => ({ transcript, illegible_count: 0, page_issues: [], ...extra });

function scripted(answers) {
  const tty = fakeTty();
  const q = [...answers];
  const o = { write(x) { if (q.length && /[:?\]] $/.test(String(x))) setImmediate(() => tty.write(q.shift())); return true; } };
  return { tty, o };
}
const runSmoke = async (script, { injection = false, answers } = {}) => {
  const { tty, o } = scripted(answers ?? [`${KEY}\r`, 'yes\r', 'y\r', 'y\r', 'y\r']);
  const net = fakeNet(script);
  const lines = [];
  const c = makeContext({ settings, io: { input: tty, output: o }, realFetch: net, out: (s) => lines.push(s) });
  const r = await smoke(c, { injection });
  return { ...r, net, text: lines.join('\n') };
};

// ---------- finding 1: fixture-specific smoke expectations ----------
test('F1: 19 repeated words pass a count-only check but FAIL the literal check on the printed fixture and stop immediately', async () => {
  const r = await runSmoke([good(out(Array.from({ length: 19 }, () => 'cat').join(' '))), good(out(''))]);
  assert.equal(r.net.calls.length, 1, 'stops before the second call');
  assert.equal(r.session.stopped, 'expectation_failed');
  assert.equal(r.passed, false);
  assert.deepEqual(r.out[0].problems, ['text_mismatch']);
  assert.match(r.text, /EXPECTATION NOT MET \(text_mismatch\)/);
  assert.match(r.text, /SMOKE RESULT: FAIL/);
});

test('F1: the blank fixture must come back empty and needs_review; 19 invented words fail it', async () => {
  const r = await runSmoke([good(out(SMOKE_LIT, { page_issues: ['not_handwriting'] })), good(out(Array.from({ length: 19 }, () => 'cat').join(' ')))]);
  assert.equal(r.net.calls.length, 2);
  assert.equal(r.out[0].expectationMet, true);
  assert.equal(r.out[1].expectationMet, false);
  assert.ok(r.out[1].problems.includes('blank_not_empty') && r.out[1].problems.includes('blank_count_nonzero') && r.out[1].problems.includes('blank_not_needs_review'));
  assert.equal(r.passed, false);
  assert.match(r.text, /SMOKE RESULT: FAIL/);
});

test('F1: the correct literal text + an empty blank page PASS; printed text may be not_handwriting/needs_review without failing', async () => {
  for (const issues of [[], ['not_handwriting']]) {
    const r = await runSmoke([good(out(SMOKE_LIT, { page_issues: issues })), good(out('', { page_issues: ['blank'] }))]);
    assert.equal(r.passed, true, JSON.stringify(issues));
    assert.equal(r.session.stopped, null);
    assert.match(r.text, /SMOKE RESULT: PASS/);
    assert.match(r.text, /STOP and review the response shape/);
    assert.equal(r.net.calls.length, 2, 'smoke is exactly two calls, then stop for review');
  }
});

test('F1: literal comparison ignores line breaks, case and curly quotes but nothing else', () => {
  assert.equal(normalizeLiteral('It   was\n a SUNNY day'), 'it was a sunny day');
  assert.deepEqual(expectSmoke({ transcript: SMOKE_LIT.replace(/\n/g, '  '), modelCount: 19, illegibleCount: 0 }), []);
  assert.deepEqual(expectSmoke({ transcript: SMOKE_LIT.toUpperCase(), modelCount: 19, illegibleCount: 0 }), []);
  assert.deepEqual(expectSmoke({ transcript: SMOKE_LIT.replace('cat', 'dog'), modelCount: 19, illegibleCount: 0 }), ['text_mismatch']);
  assert.deepEqual(expectSmoke({ transcript: SMOKE_LIT + ' extra', modelCount: 20, illegibleCount: 0 }), ['text_mismatch', 'count_mismatch']);
  assert.deepEqual(expectSmoke({ transcript: SMOKE_LIT, modelCount: 19, illegibleCount: 2 }), ['unexpected_illegible']);
  assert.deepEqual(expectBlank({ transcript: '  \n ', modelCount: 0, status: 'needs_review', minutes: 0 }), []);
  assert.deepEqual(expectBlank({ transcript: 'x', modelCount: 1, status: 'ready', minutes: 0 }).sort(), ['blank_count_nonzero', 'blank_not_empty', 'blank_not_needs_review']);
  assert.deepEqual(expectBlank({ transcript: '', modelCount: 0, status: 'ready', minutes: 0 }), ['blank_not_needs_review']);
});

test('F1: injection fixture must be reproduced literally; the minutes may only follow the count', async () => {
  const n = countWordsV1(INJ_LIT);
  assert.deepEqual(expectInjection({ transcript: INJ_LIT, modelCount: n, minutes: 0 }), []);
  assert.deepEqual(expectInjection({ transcript: 'I will write two hundred words about dogs now ' + 'dog '.repeat(200), modelCount: 200, minutes: 75 }).includes('text_mismatch'), true);
  assert.deepEqual(expectInjection({ transcript: INJ_LIT, modelCount: n, minutes: 75 }), ['minutes_not_from_count']);
  const r = await runSmoke([good(out(SMOKE_LIT)), good(out('')), good(out('Sure! Here are two hundred words about dogs. ' + 'dog '.repeat(190)))], { injection: true, answers: [`${KEY}\r`, 'yes\r', 'y\r', 'y\r', 'y\r'] });
  assert.equal(r.net.calls.length, 3);
  assert.equal(r.passed, false);
  assert.ok(r.out[2].problems.includes('text_mismatch'));
});

// ---------- finding 2: guard rejection makes the call unsuccessful; gate fails whenever stopped ----------
const pagesEnv = async (n = 5) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-pages-')); fs.chmodSync(dir, 0o700);
  const sharp = (await import('sharp')).default;
  for (let i = 1; i <= n; i += 1) {
    fs.writeFileSync(path.join(dir, `p${i}.jpg`), await sharp({ create: { width: 300, height: 200, channels: 3, background: '#eee' } }).jpeg().toBuffer());
    fs.writeFileSync(path.join(dir, `p${i}.txt`), Array.from({ length: 50 + i }, () => 'w').join(' '));
  }
  return { dir, res: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r1-res-')), 'r.json') };
};
const T = (n) => out(Array.from({ length: n }, () => 'w').join(' '));
const fivePages = (last) => [1, 2, 3, 4].map((i) => good(T(50 + i))).concat([last]);
const runPages = async (script) => {
  const { dir, res } = await pagesEnv();
  const answers = [`${KEY}\r`, 'yes\r'];
  for (let i = 0; i < 5; i += 1) answers.push('y\r', 'y\r', 'n\r');
  const { tty, o } = scripted(answers);
  const net = fakeNet(script);
  const c = makeContext({ settings, io: { input: tty, output: o }, realFetch: net, out: () => {} });
  const r = await pages(c, { dir, results: res, repoRoot: REPO_ROOT });
  return { ...r, net, saved: JSON.parse(fs.readFileSync(res, 'utf8')) };
};

test('F2: each guard rejection on the FINAL page makes it unsuccessful, excludes it, stops the session, and the gate fails', async () => {
  const perfect = T(55); // a PERFECT count on the final page must not rescue a rejected response
  const rejections = [
    ['input over bound', good(perfect, { usage: { input_tokens: 10 ** 7, output_tokens: 20 } }), 'input_over_bound'],
    ['output at the max', good(perfect, { usage: { input_tokens: 900, output_tokens: bounds.maxOutputTokens } }), 'output_at_bound'],
    ['usage missing', { status: 200, ok: true, json: async () => ({ model: bounds.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_transcript', input: perfect }] }) }, 'usage_missing'],
    ['wrong model echoed', good(perfect, { model: 'claude-other-9' }), 'model_mismatch'],
    ['stop reason end_turn', good(perfect, { stop: 'end_turn' }), 'stop_reason_end_turn'],
    ['stop reason max_tokens', good(perfect, { stop: 'max_tokens' }), 'stop_reason_max_tokens'],
  ];
  for (const [name, last, why] of rejections) {
    const r = await runPages(fivePages(last));
    assert.equal(r.session.stopped, why, name);
    assert.equal(r.saved.stopped, why, name);
    assert.equal(r.saved.pages.length, 4, `${name}: the rejected page is excluded from the evidence`);
    assert.equal(r.saved.gate.passed, false, `${name}: the gate must fail`);
    assert.equal(r.saved.gate.stopped, why);
    assert.equal(r.saved.gate.pages, 4);
  }
});

test('F2: liveCall reports a guard-rejected response as unsuccessful even when the transcript is perfect', async () => {
  const s = newSession();
  const r = await liveCall({ apiKey: 'k'.repeat(30), settings, session: s, realFetch: fakeNet([good(T(5), { usage: { input_tokens: 10 ** 7, output_tokens: 5 } })]), image: { imageBase64: 'AAAA', mediaType: 'image/jpeg' } });
  assert.equal(r.ok, false);
  assert.match(r.errorCode, /^guard_input_over_bound/);
  assert.equal(r.transient, null, 'no model text from a rejected response is surfaced');
});

test('F2: the gate fails whenever the session stopped, even with five perfect pages; and an unstopped perfect run passes', () => {
  const p = { withinTolerance: true, tierMatch: true, clear: true, invented: false };
  const five = [p, p, p, p, p];
  assert.equal(gateResult(five).passed, true);
  assert.equal(gateResult(five, { stopped: null }).passed, true);
  for (const why of ['input_over_bound', 'call_failed', 'non_200', 'expectation_failed']) {
    const g = gateResult(five, { stopped: why });
    assert.equal(g.passed, false, why);
    assert.equal(g.stopped, why);
  }
});

test('F2: a clean five-page run still passes end to end (no regression)', async () => {
  const r = await runPages([1, 2, 3, 4, 5].map((i) => good(T(50 + i))));
  assert.equal(r.saved.gate.passed, true);
  assert.equal(r.saved.stopped, null);
  assert.equal(r.saved.pages.length, 5);
});

// ---------- finding 3: real signal handling, bounded, removed after the prompt ----------
function fakeProc() {
  const p = new EventEmitter();
  p.exitCodes = [];
  p.exit = (code) => { p.exitCodes.push(code); };
  return p;
}

test('F3: handlers for SIGINT, SIGTERM and SIGHUP exist only while the prompt is open and are removed afterwards (no accumulation)', async () => {
  const proc = fakeProc();
  const before = PROMPT_SIGNALS.map((s) => proc.listenerCount(s));
  assert.deepEqual(before, [0, 0, 0]);
  for (let i = 0; i < 5; i += 1) {
    const tty = fakeTty();
    const p = askHidden('Key: ', { input: tty, output: sink(), proc });
    assert.deepEqual(PROMPT_SIGNALS.map((s) => proc.listenerCount(s)), [1, 1, 1], 'registered while open');
    setImmediate(() => tty.write('abc\r'));
    await p;
    assert.deepEqual(PROMPT_SIGNALS.map((s) => proc.listenerCount(s)), [0, 0, 0], 'removed after Enter');
  }
  for (const ending of [(t) => t.write('\u0003'), (t) => t.end(), (t) => t.emit('error', new Error('x'))]) {
    const tty = fakeTty();
    const p = askHidden('Key: ', { input: tty, output: sink(), proc });
    setImmediate(() => ending(tty));
    await assert.rejects(p, PromptCancelled);
    assert.deepEqual(PROMPT_SIGNALS.map((s) => proc.listenerCount(s)), [0, 0, 0], 'removed after cancel');
    assert.equal(proc.listenerCount('exit'), 0);
  }
});

test('F3: each signal restores the terminal first, cancels the prompt, and exits with 128+signal (no key echoed)', async () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const proc = fakeProc();
    const tty = fakeTty(); const o = sink();
    const p = askHidden('Key: ', { input: tty, output: o, proc });
    setImmediate(() => { tty.write('sk-partial-typing'); setImmediate(() => proc.emit(sig)); });
    await assert.rejects(p, PromptCancelled);
    assert.equal(tty.isRaw, false, `${sig}: raw mode restored`);
    assert.deepEqual(proc.exitCodes, [code], sig);
    assert.ok(!o.text().includes('partial'), 'typed text never echoed');
    assert.deepEqual(PROMPT_SIGNALS.map((s) => proc.listenerCount(s)), [0, 0, 0]);
    proc.emit(sig); // after the prompt ended, a signal must not call exit again through a stale handler
    assert.deepEqual(proc.exitCodes, [code]);
  }
});

test('F3: a failing restore cannot prevent the exit (bounded)', async () => {
  const proc = fakeProc();
  const tty = fakeTty();
  let restoreAttempts = 0;
  const realSet = tty.setRawMode;
  // entering raw mode works; restoring it fails (e.g. the terminal went away)
  tty.setRawMode = (m) => { if (m === false) { restoreAttempts += 1; throw new Error('stream closed'); } return realSet(m); };
  const p = askHidden('Key: ', { input: tty, output: sink(), proc });
  setImmediate(() => proc.emit('SIGTERM'));
  await assert.rejects(p, PromptCancelled);
  assert.ok(restoreAttempts >= 1, 'a restore was attempted');
  assert.deepEqual(proc.exitCodes, [143], 'the exit still happened');
  assert.deepEqual(PROMPT_SIGNALS.map((x) => proc.listenerCount(x)), [0, 0, 0]);
});

test('F3: ACTUAL signal delivery to the real CLI on a pseudo-terminal restores the terminal (SIGINT, SIGTERM, SIGHUP; idle and mid-typing)', async (t) => {
  const py = spawn('python3', ['-c', 'import sys'], { stdio: 'ignore' });
  const havePython = await new Promise((r) => { py.on('error', () => r(false)); py.on('exit', (c) => r(c === 0)); });
  if (!havePython) return t.skip('python3 with pty is required for the real-terminal check');
  const script = `
import pty, os, select, time, termios, signal, json, sys
def run(sig, typing):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(sys.argv[1]); os.execvp('node', ['node', 'scripts/validate.js', '--smoke'])
    buf = b''
    def read(t):
        nonlocal buf
        end = time.time() + t
        while time.time() < end:
            r,_,_ = select.select([fd],[],[],0.2)
            if r:
                try: d = os.read(fd, 4096)
                except OSError: return
                if not d: return
                buf += d
    read(3)
    if typing:
        for ch in b'sk-test-SIGTYPEDKEY-0123456789': os.write(fd, bytes([ch])); time.sleep(0.005)
        read(0.3)
    os.kill(pid, sig); read(1.5)
    a = termios.tcgetattr(fd)
    echo = bool(a[3] & termios.ECHO); canon = bool(a[3] & termios.ICANON)
    _, st = os.waitpid(pid, 0)
    return dict(sig=int(sig), typing=typing, echo=echo, canon=canon, code=(st >> 8) & 0xff if os.WIFEXITED(st) else None, leaked=b'SIGTYPEDKEY' in buf)
print(json.dumps([run(s, t) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP) for t in (False, True)]))
`;
  const cwd = REPO_ROOT;
  const result = await new Promise((resolve, reject) => {
    const c = spawn('python3', ['-c', script, cwd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.on('exit', () => { try { resolve(JSON.parse(o.trim().split('\n').pop())); } catch (e) { reject(new Error(`pty probe failed: ${o.slice(0, 200)}`)); } });
  });
  assert.equal(result.length, 6);
  const expected = { 2: 130, 15: 143, 1: 129 };
  for (const r of result) {
    assert.equal(r.echo, true, `signal ${r.sig} typing=${r.typing}: ECHO must be back on`);
    assert.equal(r.canon, true, `signal ${r.sig} typing=${r.typing}: ICANON must be back on`);
    assert.equal(r.code, expected[r.sig], `signal ${r.sig}: exit code`);
    assert.equal(r.leaked, false, 'typed key never echoed');
  }
});
