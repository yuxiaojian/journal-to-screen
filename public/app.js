import { createKeyHolder, fileIdOf } from './upload-key.js';
import { enablePush as enablePushFlow } from './push-enable.js';
const keys = createKeyHolder();
const app = document.getElementById('app');
const $ = (h) => { app.replaceChildren(); app.insertAdjacentHTML('beforeend', h); return app; };
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

const STATUS = { pending: 'Saved, not sent yet', sending: 'Sending', accepted_by_push_service: 'Accepted by push service (not confirmed delivered)', failed: 'Failed', unknown: 'Unknown (may or may not have been sent)', disabled_endpoint: 'Device unsubscribed' };

async function route() {
  const me = await api('/api/me');
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

function loginView(msg = '') {
  $(`<h1>Sign in</h1><form id="f"><input name="username" autocomplete="username" placeholder="Username" required><input name="password" type="password" autocomplete="current-password" placeholder="Password" required><button>Sign in</button></form><p class="err">${esc(msg)}</p>`);
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
  await api('/api/logout', { method: 'POST' });
  go('/login');
}

function uploadView(msg = '') {
  $(`<h1>Upload</h1><form id="f"><input type="file" name="photo" accept="image/*" required><button>Upload photo</button></form><p>${esc(msg)}</p><button class="secondary" id="lo">Sign out</button>`);
  document.getElementById('lo').onclick = logout;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const file = e.target.photo.files[0];
    const fd = new FormData();
    fd.append('key', keys.forFile(fileIdOf(file))); // kept across failures; reset on success or a new file
    fd.append('photo', await shrink(file), 'photo.jpg');
    const r = await api('/api/uploads', { method: 'POST', body: fd });
    if (!r.ok) return uploadView('Upload failed: ' + (r.body.error || r.status));
    keys.succeeded();
    const s = (r.body.sends || []).map((x) => STATUS[x.status]).join('; ') || 'No parent devices subscribed yet';
    uploadView(`Saved. ${r.body.duplicate ? '(already uploaded) ' : ''}Parents: ${s}`);
  };
}

// Resize on the phone; the server re-encodes anyway and is the real control.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
  } catch { return file; }
}

async function inboxView(me) {
  const r = await api('/api/uploads');
  const rows = (r.body.uploads || []).map((u) => `<div class="card"><a href="/uploads/${u.id}" data-link>${esc(new Date(u.created_at).toLocaleString())}</a><div class="muted">${u.accepted} accepted by push service${u.needs_attention ? ` · ${u.needs_attention} need attention` : ''}</div></div>`).join('') || '<p>No uploads yet.</p>';
  $(`<h1>Inbox</h1><p class="muted">${esc(me.username)}</p><button id="en">Enable notifications</button><p id="ns" class="muted"></p>${rows}<button class="secondary" id="lo">Sign out</button>`);
  document.getElementById('lo').onclick = logout;
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
  if (!r.ok) return $('<h1>Not available</h1><p>This upload is unavailable or has expired.</p><a href="/" data-link>Back</a>');
  const img = role === 'uploader' ? '' : `<img alt="Uploaded photo" src="/api/uploads/${id}/image">`;
  const sends = r.body.sends.map((s) => `<li>${esc(s.parent)}: ${esc(STATUS[s.status] || s.status)}</li>`).join('');
  $(`<h1>Upload</h1><p class="muted">${esc(new Date(r.body.upload.created_at).toLocaleString())}</p>${img}<ul>${sends}</ul>${role === 'uploader' ? '' : '<button id="rs">Resend notifications</button><p id="rm" class="muted"></p>'}<a href="/" data-link>Inbox</a>`);
  document.querySelectorAll('[data-link]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go('/'); }));
  const rs = document.getElementById('rs');
  if (rs) rs.onclick = async () => {
    let x = await api(`/api/uploads/${id}/resend`, { method: 'POST', json: {} });
    if (x.status === 409 && confirm(x.body.message)) x = await api(`/api/uploads/${id}/resend`, { method: 'POST', json: { confirmDuplicate: true } });
    resultView(id, role);
  };
}

route();
