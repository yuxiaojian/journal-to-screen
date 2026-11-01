import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('client: model/parent text is only ever assigned via .value or .textContent, never into HTML', () => {
  // transcript, original transcript and error strings must not appear inside any template-literal HTML interpolation
  const html = [...src.matchAll(/innerHTML\s*=\s*`([\s\S]*?)`;/g)].map((m) => m[1]).join('\n');
  // No interpolation in any HTML template may reference a transcript field (booleans like `j.corrected ?` are fine).
  const interpolations = [...html.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  for (const expr of interpolations) assert.ok(!/transcript/.test(expr), `HTML interpolation references a transcript field: ${expr}`);
  assert.ok(interpolations.length > 0);
  assert.match(src, /getElementById\('tx'\)\.value = cur\.transcript/);
  assert.match(src, /orig\.textContent = j\.original\.transcript/);
  // numbers are coerced, strings that are interpolated go through esc()
  assert.match(src, /Number\(cur\.wordCount\)/);
  assert.match(src, /Number\(cur\.suggestedMinutes\)/);
  assert.match(src, /esc\(ERRORS\[j\.error\]/);
});

test('client: the real journalPanel renders hostile text safely and drives save / conflict / paused', async () => {
  // Extract and execute the real journalPanel + helpers against a tiny fake DOM.
  const grab = (name) => src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`))[0];
  const consts = ['JOURNAL_STATUS', 'ERRORS', 'FLAGS'].map((n) => src.match(new RegExp(`const ${n} = \\{[^\\n]*\\};`))[0]).join('\n');
  const esc = src.match(/const esc = [^\n]*\n/)[0];
  const els = {};
  const make = (id) => (els[id] ??= { id, value: '', textContent: '', innerHTML: '', onclick: null });
  const calls = [];
  const code = `${consts}\n${esc}\nlet RESP = [];\nconst api = async (p, o) => { calls.push([p, o && o.json]); return RESP.shift(); };\n${grab('journalPanel')}\nreturn { journalPanel, setResp: (r) => { RESP = r; } };`;
  const document = { getElementById: (id) => (id === 'jv' ? make('jv') : (els[id] && els[id].mounted ? els[id] : (els[id] = els[id] || null))) };
  // innerHTML assignment mounts the child controls the panel looks up afterwards
  const jv = make('jv');
  Object.defineProperty(jv, 'innerHTML', { set(v) { this._html = v; for (const m of v.matchAll(/id="(\w+)"/g)) { make(m[1]).mounted = true; } }, get() { return this._html || ''; } });
  const mod = new Function('document', 'calls', code)(document, calls);
  const evil = '<img src=x onerror=alert(1)> & "quotes"';
  const j = { status: 'ready', provisional: true, version: 7, original: { transcript: evil, wordCount: 3, suggestedMinutes: 0, flags: ['near_threshold'], pageIssues: ['<b>blurry</b>'] }, corrected: null };
  mod.journalPanel('abc', j);
  assert.ok(!jv.innerHTML.includes('<img'), 'hostile transcript must not reach innerHTML');
  assert.ok(!jv.innerHTML.includes('<b>blurry'), 'page issues are escaped');
  assert.equal(els.tx.value, evil); // exact text goes into the textarea value
  assert.match(jv.innerHTML, /Needs your review/);
  // save sends the version it loaded, and a 409 reloads instead of overwriting
  els.tx.value = 'edited';
  mod.setResp([{ status: 409, ok: false, body: {} }, { ok: true, status: 200, body: { journal: { ...j, version: 9, provisional: false, corrected: { transcript: 'theirs', wordCount: 1, suggestedMinutes: 0, flags: [] } } } }]);
  await els.sv.onclick();
  assert.deepEqual(calls[0], ['/api/uploads/abc/correction', { transcript: 'edited', version: 7 }]);
  assert.equal(calls[1][0], '/api/uploads/abc'); // reloaded the latest after the conflict
  assert.equal(els.tx.value, 'theirs');
  // the conflict explanation is set after the re-render, so it is still there
  assert.match(els.jm.textContent, /Someone else changed this/);
  assert.equal(els.jm.hidden, false);
  // failed state: escaped error text, no retry control of any kind
  mod.journalPanel('abc', { status: 'failed', error: 'budget' });
  assert.match(jv.innerHTML, /monthly reading allowance/);
  assert.ok(!jv.innerHTML.includes('id="rt"') && !/Try reading again/.test(jv.innerHTML));
  assert.match(jv.innerHTML, /upload the page again/);
  mod.journalPanel('abc', { status: 'failed', error: '<script>x</script>' });
  assert.ok(!jv.innerHTML.includes('<script>'));
  // paused: AI is off, so never say "Reading"
  mod.journalPanel('abc', { status: 'queued', paused: true });
  assert.match(jv.innerHTML, /Analysis paused; photo available/);
  assert.ok(!/Reading the page/.test(jv.innerHTML));
  mod.journalPanel('abc', { status: 'queued', paused: false });
  assert.match(jv.innerHTML, /Reading the page/);
  // a corrected view shows the original separately
  mod.journalPanel('abc', { ...j, provisional: false, corrected: { transcript: 'fixed', wordCount: 1, suggestedMinutes: 0, flags: [] } });
  assert.equal(els.tx.value, 'fixed');
  assert.equal(els.orig.textContent, evil);
});
