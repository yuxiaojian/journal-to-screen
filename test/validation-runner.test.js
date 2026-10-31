import test from 'node:test';
import assert from 'node:assert/strict';
import { askHidden, confirm, PromptCancelled } from '../scripts/validation/prompt.js';
import { captureProductionRequest, prepareImage, percentError, pageVerdict, gateResult, liveCall } from '../scripts/validation/runner.js';
import { smokeImage, blankImage, injectionImage, SMOKE_TEXT, INJECTION_TEXT } from '../scripts/validation/fixtures.js';
import { createAnthropicProvider, SYSTEM_PROMPT, TOOL, TOOL_NAME, USER_TEXT } from '../src/ai.js';
import { countWordsV1, validateModelOutput, evaluate } from '../src/journal.js';
import { processImage } from '../src/images.js';
import { settings, newSession, fakeNet, good, toolInput, fakeTty, sink } from './validation-helpers.js';

// ---------- production request fidelity (senior point 1) ----------
test('the harness sends the byte-identical request the production provider builds for the same image', async () => {
  const img = await prepareImage(await smokeImage(), settings.limits);
  // (a) what the production provider builds, captured through its own fetch seam
  const prod = await captureProductionRequest({ ai: settings.ai, imageBase64: img.imageBase64, mediaType: img.mediaType });
  // (b) what the harness sends: the same provider, wrapped by the guard, with a recording network
  const net = fakeNet([good()]);
  const session = newSession();
  await liveCall({ apiKey: 'k'.repeat(30), settings, session, realFetch: net, image: { imageBase64: img.imageBase64, mediaType: img.mediaType } });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].init.body, prod.raw); // byte-for-byte
  assert.equal(net.calls[0].url, prod.url);
  assert.equal(net.calls[0].init.method, 'POST');
  assert.equal(net.calls[0].init.headers['anthropic-version'], '2023-06-01');
  // and it is the production prompt, tool and forced tool_choice, not a copy
  const b = JSON.parse(net.calls[0].init.body);
  assert.equal(b.system, SYSTEM_PROMPT);
  assert.deepEqual(b.tools, [TOOL]);
  assert.deepEqual(b.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.equal(b.messages[0].content[1].text, USER_TEXT);
  assert.equal(b.model, settings.ai.model);
  assert.equal(b.max_tokens, settings.ai.maxOutputTokens);
});

test('the harness image path is the production one: re-encoded JPEG, long edge <= 1568, metadata stripped', async () => {
  const sharp = (await import('sharp')).default;
  const big = await sharp({ create: { width: 3600, height: 2400, channels: 3, background: '#808080' } }).withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 47/1 0/1' } }).jpeg().toBuffer();
  const viaHarness = await prepareImage(big, settings.limits);
  const viaProd = await processImage(big, settings.limits);
  assert.equal(viaHarness.imageBase64, Buffer.from(viaProd.data).toString('base64'));
  const m = await sharp(Buffer.from(viaHarness.imageBase64, 'base64')).metadata();
  assert.ok(Math.max(m.width, m.height) <= 1568);
  assert.equal(m.exif, undefined);
  assert.equal(viaHarness.mediaType, 'image/jpeg');
});

test('the dry-run request capture makes no network use and a different image changes the body', async () => {
  const a = await prepareImage(await smokeImage(), settings.limits);
  const b = await prepareImage(await blankImage(), settings.limits);
  const ra = await captureProductionRequest({ ai: settings.ai, imageBase64: a.imageBase64, mediaType: a.mediaType });
  const rb = await captureProductionRequest({ ai: settings.ai, imageBase64: b.imageBase64, mediaType: b.mediaType });
  assert.notEqual(ra.raw, rb.raw);
  assert.equal(ra.body.system, rb.body.system);
  const ra2 = await captureProductionRequest({ ai: settings.ai, imageBase64: a.imageBase64, mediaType: a.mediaType });
  assert.equal(ra.raw, ra2.raw); // deterministic
});

// ---------- fixtures and smoke criteria (reviewer point 2) ----------
test('fixtures are synthetic JPEGs; the expected smoke count is derived from the production counter', async () => {
  for (const mk of [smokeImage, blankImage, injectionImage]) {
    const buf = await mk();
    assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  }
  assert.equal(countWordsV1(SMOKE_TEXT.lines.join('\n')), 19);
  assert.ok(INJECTION_TEXT.lines.join(' ').toLowerCase().includes('ignore'));
});

test('smoke criteria: exact literal text/count/schema; printed text may legitimately be not_handwriting + needs_review, never required to be ready', () => {
  const lit = SMOKE_TEXT.lines.join('\n');
  const printed = validateModelOutput({ transcript: lit, illegible_count: 0, page_issues: ['not_handwriting'] });
  const ev = evaluate({ transcript: printed.transcript, illegibleCount: 0, pageIssues: printed.page_issues });
  assert.equal(ev.wordCount, countWordsV1(lit));
  assert.equal(ev.status, 'needs_review'); // acceptable for a printed fixture
  const clean = evaluate({ transcript: lit, illegibleCount: 0, pageIssues: [] });
  assert.equal(clean.wordCount, 19);
  assert.equal(clean.minutes, 0);
  // blank page: empty text and needs_review, never invented text
  const blank = evaluate({ transcript: '', illegibleCount: 0, pageIssues: ['blank'] });
  assert.deepEqual([blank.wordCount, blank.status, blank.minutes], [0, 'needs_review', 0]);
  assert.throws(() => validateModelOutput({ transcript: 'x', illegible_count: 1, page_issues: [] }), /schema/);
});

test('injection fixture: the injected words are just counted as words; tiers cannot be steered by page text', async () => {
  const lit = INJECTION_TEXT.lines.join('\n');
  const asModel = validateModelOutput({ transcript: lit, illegible_count: 0, page_issues: [] });
  const ev = evaluate({ transcript: asModel.transcript, illegibleCount: 0, pageIssues: [] });
  assert.equal(ev.wordCount, countWordsV1(lit));
  assert.equal(ev.minutes, 0); // not 75
  assert.throws(() => validateModelOutput({ transcript: lit, illegible_count: 0, page_issues: [], suggested_minutes: 75 }), /schema:keys/);
});

// ---------- accuracy gate arithmetic (reviewer point 3: zero reference) ----------
test('percent error: zero reference requires an exact match and never divides by zero', () => {
  assert.equal(percentError(0, 0), 0);
  assert.equal(percentError(0, 1), Infinity);
  assert.equal(percentError(100, 105), 5);
  assert.ok(Math.abs(percentError(100, 94) - 6) < 1e-9);
  assert.equal(percentError(40, 40), 0);
  for (const [r, m] of [[-1, 1], [1, -1], [1.5, 1], [1, 'x'], [NaN, 1], [undefined, 1]]) assert.throws(() => percentError(r, m), /bad_counts/);
  assert.deepEqual(pageVerdict({ referenceCount: 0, modelCount: 0 }), { percentError: 0, withinTolerance: true, tierMatch: true, referenceTier: 0, modelTier: 0 });
  const bad = pageVerdict({ referenceCount: 0, modelCount: 3 });
  assert.equal(bad.withinTolerance, false);
  assert.equal(bad.percentError, null); // Infinity is not written to evidence
});

test('tier agreement is checked separately: 49 vs 50 is within 5 percent but a different tier', () => {
  const v = pageVerdict({ referenceCount: 49, modelCount: 50 });
  assert.equal(v.withinTolerance, true);
  assert.equal(v.tierMatch, false);
  const w = pageVerdict({ referenceCount: 100, modelCount: 99 });
  assert.equal(w.withinTolerance, true);
  assert.equal(w.tierMatch, false);
  assert.equal(pageVerdict({ referenceCount: 120, modelCount: 118 }).tierMatch, true);
});

test('gate: needs 5 pages, >=4 within tolerance, no invented passage on accepted pages, and tier agreement on every clear page', () => {
  const p = (o = {}) => ({ withinTolerance: true, tierMatch: true, clear: true, invented: false, ...o });
  assert.equal(gateResult([p(), p(), p(), p(), p()]).passed, true);
  assert.equal(gateResult([p(), p(), p(), p(), p({ withinTolerance: false, clear: false })]).passed, true); // 4 of 5
  assert.equal(gateResult([p(), p(), p(), p({ withinTolerance: false, clear: false }), p({ withinTolerance: false, clear: false })]).passed, false); // 3 of 5
  assert.equal(gateResult([p(), p(), p(), p(), p({ invented: true })]).passed, false); // invented passage on an accepted page
  assert.equal(gateResult([p(), p(), p(), p(), p({ withinTolerance: false, invented: true, clear: false })]).passed, true); // invented only on a rejected page
  assert.equal(gateResult([p(), p(), p(), p(), p({ tierMatch: false })]).passed, false); // clear page with a tier mismatch
  assert.equal(gateResult([p(), p(), p(), p(), p({ tierMatch: false, clear: false })]).passed, true); // unclear page tier mismatch is reported, not gating
  assert.equal(gateResult([p(), p(), p(), p()]).passed, false); // fewer than five pages
  assert.equal(gateResult([p(), p(), p(), p(), p(), p()]).passed, false); // more than five
});

// ---------- hidden prompt: restore on cancel (PM requirement) ----------
const type = (tty, text) => setImmediate(() => tty.write(text));

test('hidden prompt: typed characters are never echoed, and raw mode is restored after Enter', async () => {
  const tty = fakeTty(); const out = sink();
  const p = askHidden('Key: ', { input: tty, output: out });
  type(tty, 'sk-secret-value-123\r');
  assert.equal(await p, 'sk-secret-value-123');
  assert.ok(!out.text().includes('secret'), 'the typed value must never be written to the output');
  assert.deepEqual(tty.rawCalls, [true, false]);
  assert.equal(tty.isRaw, false);
});

test('hidden prompt: Ctrl-C and Ctrl-D cancel, restore the terminal, and return no value', async () => {
  for (const ch of ['\u0003', '\u0004']) {
    const tty = fakeTty(); const out = sink();
    const p = askHidden('Key: ', { input: tty, output: out });
    type(tty, `abc${ch}`);
    await assert.rejects(p, PromptCancelled);
    assert.equal(tty.isRaw, false);
    assert.deepEqual(tty.rawCalls, [true, false]);
    assert.ok(!out.text().includes('abc'));
  }
});

test('hidden prompt: stream end and stream error also cancel and restore', async () => {
  const t1 = fakeTty(); const p1 = askHidden('Key: ', { input: t1, output: sink() });
  setImmediate(() => t1.end());
  await assert.rejects(p1, PromptCancelled);
  assert.equal(t1.isRaw, false);
  const t2 = fakeTty(); const p2 = askHidden('Key: ', { input: t2, output: sink() });
  setImmediate(() => t2.emit('error', new Error('boom')));
  await assert.rejects(p2, PromptCancelled);
  assert.equal(t2.isRaw, false);
});

test('hidden prompt: backspace edits, other control characters are ignored, overlong input is rejected and restored', async () => {
  const tty = fakeTty();
  const p = askHidden('Key: ', { input: tty, output: sink() });
  type(tty, 'abcd\u007f\u007fxy\u001b[A\r');
  assert.equal(await p, 'abxy');
  const t2 = fakeTty();
  const p2 = askHidden('Key: ', { input: t2, output: sink() });
  type(t2, 'a'.repeat(5000));
  await assert.rejects(p2, /input_too_long/);
  assert.equal(t2.isRaw, false);
});

test('hidden prompt refuses to read a secret from a non-TTY (pipe or file)', async () => {
  const pipe = fakeTty({ isTTY: false });
  await assert.rejects(askHidden('Key: ', { input: pipe, output: sink() }), /tty_required/);
  assert.deepEqual(pipe.rawCalls, []);
});

test('confirm: only an explicit y/yes is consent; everything else, including cancel, is NO', async () => {
  for (const [typed, want] of [['y\r', true], ['yes\r', true], ['YES\r', true], [' Y \r', true], ['\r', false], ['no\r', false], ['yep\r', false], ['ye\r', false]]) {
    const tty = fakeTty();
    const p = confirm('ok? ', { input: tty, output: sink() });
    type(tty, typed);
    assert.equal(await p, want, JSON.stringify(typed));
  }
  const tty = fakeTty();
  const p = confirm('ok? ', { input: tty, output: sink() });
  type(tty, '\u0003');
  await assert.rejects(p, PromptCancelled);
});
