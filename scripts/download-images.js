// Run LOCALLY on the parent's own machine, by the parent or their local agent:
//   JOURNAL_USERNAME=... JOURNAL_PASSWORD=... node scripts/download-images.js [--out journal-images] [--url https://...]
// Signs in as a parent, saves page photos the folder does not already have, then signs out. Read-only on the server
// apart from that session. The password comes only from the environment: never argv, files or output.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// A password may only travel over HTTPS, or to this machine for local testing.
export function validateBaseUrl(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('--url must be https');
  return u.origin;
}

export async function downloadImages({ baseUrl, username, password, outDir, fetchImpl = fetch }) {
  const origin = validateBaseUrl(baseUrl);
  const headers = { 'X-STM-Request': '1', Origin: origin };
  const login = await fetchImpl(`${origin}/api/login`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status})`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  try {
    await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
    const existing = await fs.readdir(outDir);
    const saved = [];
    let skipped = 0;
    let before = null;
    do {
      const list = await fetchImpl(`${origin}/api/uploads${before ? `?before=${encodeURIComponent(before)}` : ''}`, { headers: { Cookie: cookie } });
      if (!list.ok) throw new Error(`could not list uploads (${list.status}); a parent login is required`);
      const { uploads, next } = await list.json();
      for (const up of uploads) {
        if (!SAFE_ID.test(up.id)) throw new Error('unexpected upload id from server');
        if (existing.some((f) => f.includes(`_${up.id}.`))) {
          skipped += 1;
          continue;
        }
        const img = await fetchImpl(`${origin}/api/uploads/${up.id}/image`, { headers: { Cookie: cookie } });
        if (!img.ok) throw new Error(`could not download an image (${img.status})`);
        const ext = EXT[(img.headers.get('content-type') || '').split(';')[0]];
        if (!ext) throw new Error('unexpected image type from server');
        const stamp = new Date(up.created_at).toISOString().replace(/[:.]/g, '-');
        const name = `${stamp}_${up.id}.${ext}`;
        const tmp = path.join(outDir, `.${name}.part`);
        await fs.writeFile(tmp, Buffer.from(await img.arrayBuffer()), { mode: 0o600 });
        await fs.rename(tmp, path.join(outDir, name)); // a partial file is never mistaken for a finished download
        saved.push(name);
      }
      before = next;
    } while (before);
    return { saved, skipped };
  } finally {
    await fetchImpl(`${origin}/api/logout`, { method: 'POST', headers: { ...headers, Cookie: cookie } }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const { JOURNAL_USERNAME: username, JOURNAL_PASSWORD: password, JOURNAL_URL } = process.env;
  const baseUrl = arg('--url', JOURNAL_URL);
  if (!username || !password || !baseUrl) {
    console.error('Set JOURNAL_USERNAME and JOURNAL_PASSWORD, and pass --url or set JOURNAL_URL.');
    process.exit(1);
  }
  try {
    const r = await downloadImages({ baseUrl, username, password, outDir: arg('--out', 'journal-images') });
    console.log(`Saved ${r.saved.length}, already had ${r.skipped}.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
