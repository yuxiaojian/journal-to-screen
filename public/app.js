import { createUploadFlow, friendlyError, canRetry, STATUS as UP } from './upload-flow.js';
import { enablePush as enablePushFlow } from './push-enable.js';
const app = document.getElementById('app');
const $ = (h, wide = false) => { app.className = wide ? 'wide' : ''; app.replaceChildren(); app.insertAdjacentHTML('beforeend', h); app.querySelector('h1')?.setAttribute('tabindex', '-1'); return app; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
  const headers = { 'x-stm-request': '1', ...(opts.headers || {}) };
  if (opts.json) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
};
// Only same-origin absolute paths are accepted as a return target.
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/.test(n) && !n.startsWith('/login') ? n : null);
const go = (p) => { history.pushState({}, '', p); route(); };
window.addEventListener('popstate', route);

const JOURNAL_STATUS = { queued: 'Reading…', processing: 'Reading…', ready: 'Ready', needs_review: 'Needs your review', failed: 'Could not read' };
const ERRORS = { budget: 'The monthly reading allowance is used up.', invalid_output: 'The result could not be understood.', expired: 'This upload expired.', stalled: 'The reading was interrupted.', timeout: 'The reading timed out.', refused: 'The page was not processed.', truncated: 'The result was cut off.' };
const FLAGS = { illegible_marker: 'Some words could not be read ([?]).', page_issue: 'The page has a problem (see below).', empty_transcript: 'No text was found.', near_threshold: 'The count is close to a time-tier boundary, please check the text.' };
const STATUS = { pending: 'Saved, not sent yet', sending: 'Sending', accepted_by_push_service: 'Accepted by push service (not confirmed delivered)', failed: 'Failed', unknown: 'Unknown (may or may not have been sent)', disabled_endpoint: 'Device unsubscribed' };

// The upload flow belongs to one signed-in user. Any change of user (or signing out) resets it.
let currentUser;
function noteUser(username) {
  if (currentUser !== undefined && currentUser !== username) flow.reset();
  currentUser = username;
}

async function route() {
  const me = await api('/api/me');
  noteUser(me.ok ? me.body.username : null);
  const path = location.pathname;
  if (!me.ok) {
    if (path !== '/login') return go('/login' + (path !== '/' ? '?next=' + encodeURIComponent(path) : ''));
    return loginView();
  }
  const role = me.body.role;
  const m = path.match(/^\/uploads\/([0-9a-f-]{36})$/);
  if (m) return resultView(m[1], role);
  if (path === '/login' || path === '/') return go(role === 'uploader' ? '/upload' : '/inbox');
  if (path === '/upload' && role === 'uploader') return uploadView();
  if (path === '/inbox' && role !== 'uploader') return inboxView(me.body);
  return go(role === 'uploader' ? '/upload' : '/inbox');
}

const header = (who) => `<header class="bar"><span class="brand">Journal</span>${who ? `<span class="who">${esc(who)}</span><button type="button" class="link" id="lo">Sign out</button>` : ''}</header>`;
const wireLogout = () => { const b = document.getElementById('lo'); if (b) b.onclick = logout; };

function loginView(msg = '') {
  $(`${header()}<section class="card narrow"><h1>Sign in</h1><form id="f" novalidate>
    <label for="un">Username</label><input id="un" name="username" autocomplete="username" placeholder="Username" required>
    <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
    <button class="primary" type="submit">Sign in</button></form><p class="err" role="alert">${esc(msg)}</p></section>`);
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api('/api/login', { method: 'POST', json: { username: fd.get('username'), password: fd.get('password') } });
    if (!r.ok) return loginView(r.status === 429 ? 'Too many attempts. Wait and retry.' : 'Sign-in failed.');
    go(safeNext(new URLSearchParams(location.search).get('next')) || '/');
  };
}

async function logout() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api('/api/subscriptions', { method: 'DELETE', json: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  } catch { /* best effort; server also detaches by session on logout */ }
  flow.reset(); // before the session ends, so nothing of this account's can be sent afterwards
  await api('/api/logout', { method: 'POST' });
  go('/login');
}

// ---- child: camera-first upload ----
const flow = createUploadFlow({
  prepare: async (file) => shrink(file),
  send: async (blob, key, signal) => {
    // Last check right before sending: the browser's session must still be the account that chose the photo
    // (another tab may have signed in as someone else). If not, drop this photo instead of sending it.
    const me = await api('/api/me', { signal });
    if (!me.ok || me.body.username !== currentUser) { noteUser(me.ok ? me.body.username : null); throw new Error('account_changed'); }
    const fd = new FormData();
    fd.append('key', key);
    fd.append('photo', blob, 'photo.jpg');
    return api('/api/uploads', { method: 'POST', body: fd, signal });
  },
  onChange: () => renderUploadStatus(),
});

function uploadView() {
  $(`${header('Uploader')}<section class="card narrow"><h1>Upload</h1>
    <p class="muted">Take a clear photo of today's journal page. It is sent to your parents right away.</p>
    <input id="cam" class="vh" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">
    <input id="lib" class="vh" type="file" accept="image/*" tabindex="-1" aria-hidden="true">
    <button type="button" class="primary" id="take">Take photo &amp; upload</button>
    <button type="button" class="secondary" id="choose">Choose from library</button>
    <div id="picked" class="picked" hidden><span id="pickedName"></span><button type="button" class="primary" id="send">Upload photo</button></div>
    <div id="st" class="status" role="status" aria-live="polite"></div>
    <div id="retryRow" class="row" hidden><button type="button" class="primary" id="retry">Try again</button><button type="button" class="secondary" id="change">Choose a different photo</button></div>
  </section>`);
  wireLogout();
  const cam = document.getElementById('cam');
  const lib = document.getElementById('lib');
  // Each picker is opened directly from a tap. Its value is cleared first so the same photo can be chosen again.
  document.getElementById('take').onclick = () => { if (!flow.busy()) { cam.value = ''; cam.click(); } };
  document.getElementById('choose').onclick = () => { if (!flow.busy()) { lib.value = ''; lib.click(); } };
  document.getElementById('change').onclick = () => { if (!flow.busy()) { lib.value = ''; lib.click(); } };
  cam.onchange = () => { flow.select(cam.files && cam.files[0], 'camera'); cam.value = ''; };
  lib.onchange = () => { flow.select(lib.files && lib.files[0], 'library'); lib.value = ''; };
  document.getElementById('send').onclick = () => flow.upload();
  document.getElementById('retry').onclick = () => flow.retry();
  renderUploadStatus();
}

function renderUploadStatus() {
  const st = document.getElementById('st');
  if (!st) return; // not on the upload page; state is kept for when it is shown again
  const s = flow.state;
  const busy = flow.busy();
  for (const id of ['take', 'choose', 'send', 'retry', 'change']) { const b = document.getElementById(id); if (b) b.disabled = busy; }
  const picked = document.getElementById('picked');
  picked.hidden = !(s.status === UP.SELECTED && s.source === 'library');
  if (!picked.hidden) document.getElementById('pickedName').textContent = 'Photo selected.';
  // One primary action at a time: after a failure, "Try again" is primary and "Take photo" steps back.
  document.getElementById('take').className = s.status === UP.FAILED && canRetry(s.error) ? 'secondary' : 'primary';
  const retryRow = document.getElementById('retryRow');
  retryRow.hidden = s.status !== UP.FAILED;
  if (s.status === UP.FAILED) document.getElementById('retry').hidden = !canRetry(s.error);
  const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
  const msg = {
    [UP.IDLE]: '',
    [UP.SELECTED]: s.source === 'library' ? 'Ready to upload.' : '',
    [UP.PREPARING]: chip('busy', 'Preparing photo…'),
    [UP.UPLOADING]: chip('busy', 'Uploading…'),
    [UP.DONE]: `${chip('ok', 'Sent')} <span>Your parents will look at it soon.</span>`,
    [UP.FAILED]: `${chip('bad', 'Not sent')} <span>${esc(friendlyError(s.error))}</span>`,
  }[s.status];
  st.innerHTML = msg;
  st.setAttribute('aria-busy', String(busy));
}

// Resize on the phone; the server re-encodes anyway and is the real control.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
  } catch { return file; }
}

const CHIP = { queued: 'busy', processing: 'busy', ready: 'ok', needs_review: 'warn', failed: 'bad' };
async function inboxView(me) {
  const r = await api('/api/uploads');
  const rows = (r.body.uploads || []).map((u) => {
    const status = u.analysis_status ? (u.paused ? 'Analysis paused; photo available' : (JOURNAL_STATUS[u.analysis_status] || u.analysis_status)) : `${u.accepted} accepted by push service`;
    const cls = u.analysis_status ? (u.paused ? 'muted' : (CHIP[u.analysis_status] || 'muted')) : 'muted';
    const mins = u.suggested_minutes != null ? `<span class="mins">suggested ${Number(u.suggested_minutes)} min</span>` : '';
    const attn = u.needs_attention ? `<span class="muted">${Number(u.needs_attention)} notice(s) need attention</span>` : '';
    return `<li><a class="item" href="/uploads/${u.id}" data-link><span class="when">${esc(new Date(u.created_at).toLocaleString())}</span><span class="chip ${cls}">${esc(status)}</span>${mins}${attn}</a></li>`;
  }).join('');
  $(`${header(me.username)}<section><div class="head"><h1>Inbox</h1><button type="button" class="secondary small" id="en">Enable notifications</button></div><p id="ns" class="muted" role="status"></p>
    ${rows ? `<ul class="list">${rows}</ul>` : '<p class="card">No uploads yet.</p>'}</section>`, true);
  wireLogout();
  document.getElementById('en').onclick = enablePush;
  document.querySelectorAll('[data-link]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.getAttribute('href')); }));
}

async function enablePush() {
  const out = document.getElementById('ns');
  try {
    const r = await enablePushFlow({
      hasPush: 'serviceWorker' in navigator && 'PushManager' in window,
      notification: Notification,
      registerSw: async () => { const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return reg; },
      getSubscription: (reg) => reg.pushManager.getSubscription(),
      vapidKey: async () => {
        const cfg = (await api('/api/config')).body;
        const b64 = cfg.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
      },
      subscribe: (reg, key) => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
      postSubscription: async (sub) => (await api('/api/subscriptions', { method: 'POST', json: sub.toJSON() })).ok,
    });
    out.textContent = r.msg;
  } catch { out.textContent = 'Could not enable notifications.'; }
}

async function resultView(id, role) {
  const r = await api('/api/uploads/' + id);
  if (!r.ok) return $(`${header()}<section class="card narrow"><h1>Not available</h1><p>This upload is unavailable or has expired.</p><a href="/" data-link>Back</a></section>`);
  const j = r.body.journal;
  if (role === 'uploader') {
    const msg = j && j.state === 'processing' ? 'Sent. Your parents will look at it soon.' : 'Sent to your parents.';
    $(`${header('Uploader')}<section class="card narrow"><h1>Upload</h1><p>${esc(msg)}</p><a href="/" data-link>Back</a></section>`);
    wireLogout();
    document.querySelectorAll('[data-link]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go('/'); }));
    return;
  }
  const sends = (r.body.sends || []).map((s) => `<li>${esc(s.parent)}: ${esc(STATUS[s.status] || s.status)}</li>`).join('');
  $(`${header('Parent')}<section><p><a href="/" data-link>← Inbox</a></p><div class="head"><h1>Journal page</h1><span class="muted">${esc(new Date(r.body.upload.created_at).toLocaleString())}</span></div>
    <div class="split"><figure class="card photo"><a href="/api/uploads/${id}/image" target="_blank" rel="noopener"><img alt="Uploaded photo" src="/api/uploads/${id}/image"></a><figcaption class="muted">Open the photo full size to compare.</figcaption></figure>
    <div class="card" id="jv"></div></div>
    <details class="card"><summary>Notifications</summary><ul>${sends}</ul><button type="button" id="rs" class="secondary">Resend notifications</button></details></section>`, true);
  wireLogout();
  document.querySelectorAll('[data-link]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go('/'); }));
  document.getElementById('rs').onclick = async () => {
    let x = await api(`/api/uploads/${id}/resend`, { method: 'POST', json: {} });
    if (x.status === 409 && confirm(x.body.message)) x = await api(`/api/uploads/${id}/resend`, { method: 'POST', json: { confirmDuplicate: true } });
    resultView(id, role);
  };
  journalPanel(id, j);
}

function journalPanel(id, j, notice = '') {
  const box = document.getElementById('jv');
  if (!j) { box.textContent = ''; box.hidden = true; return; }
  box.hidden = false;
  const cur = j.corrected || j.original;
  const flagList = (j.corrected ? j.corrected.flags : (j.original && j.original.flags)) || [];
  const flags = flagList.map((f) => `<li>${esc(FLAGS[f] || f)}</li>`).join('');
  const issues = j.original && j.original.pageIssues && j.original.pageIssues.length ? `<p class="muted">Page problems: ${esc(j.original.pageIssues.join(', '))}</p>` : '';
  if (j.paused) {
    box.innerHTML = '<p>Analysis paused; photo available.</p><p class="muted">The page will be read when analysis is turned back on. You can still decide from the photo.</p>';
    return;
  }
  if (j.status === 'queued' || j.status === 'processing') {
    box.innerHTML = '<p>Reading the page… this can take a minute.</p><button type="button" id="rf" class="secondary">Refresh</button>';
    document.getElementById('rf').onclick = async () => journalPanel(id, (await api('/api/uploads/' + id)).body.journal);
    return;
  }
  if (j.status === 'failed') {
    box.innerHTML = `<p class="err">${esc(ERRORS[j.error] || 'The page could not be read.')} No time is suggested.</p><p class="muted">You can still decide from the photo. To try again, upload the page again.</p>`;
    return;
  }
  box.innerHTML = `${j.provisional ? '<p class="notice warn"><strong>Needs your review.</strong> This suggestion is provisional.</p>' : ''}
    <div class="stats"><div><span class="big">${Number(cur.wordCount)} words</span></div><div>Suggested: <strong>${Number(cur.suggestedMinutes)} min</strong>${j.corrected ? ' <span class="muted">(from your corrected text)</span>' : ''}</div>
    <div class="muted">You decide the final time in Family Link.</div></div>${flags ? `<ul class="flags">${flags}</ul>` : ''}${issues}
    <label for="tx">Text (edit to correct)</label>
    <textarea id="tx" rows="12"></textarea>
    <button type="button" class="primary" id="sv">Save correction</button><p id="jm" class="notice" role="status" aria-live="polite" hidden></p>
    ${j.corrected ? '<details><summary>Original reading</summary><pre id="orig"></pre></details>' : ''}`;
  document.getElementById('tx').value = cur.transcript; // set as text, never as HTML
  const orig = document.getElementById('orig'); if (orig) orig.textContent = j.original.transcript;
  const jm = document.getElementById('jm');
  const say = (text) => { jm.textContent = text; jm.hidden = !text; };
  say(notice); // shown after the panel is rendered, so a re-render cannot wipe it
  document.getElementById('sv').onclick = async () => {
    const sv = document.getElementById('sv');
    sv.disabled = true;
    try {
      const x = await api(`/api/uploads/${id}/correction`, { method: 'POST', json: { transcript: document.getElementById('tx').value, version: j.version } });
      if (x.status === 409) {
        const f = await api('/api/uploads/' + id);
        return journalPanel(id, f.body.journal, 'Someone else changed this while you were editing. Your edit was not saved; the latest saved text is shown.');
      }
      if (!x.ok) { say('Could not save. Please try again.'); return; }
      journalPanel(id, x.body.journal, 'Saved.');
    } catch {
      say("Couldn't save. Check the connection, then try again. Your edit is still here."); // the edited text stays
    } finally {
      sv.disabled = false; // harmless if the panel was re-rendered and this button is gone
    }
  };
}

route();
