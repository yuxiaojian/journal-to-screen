// One rule for every database URL the test tooling is given (black-box admin URL, CI service URL, unit-test URL):
// it must point at this machine. Checked BEFORE any connection, database creation or drop is attempted, so a
// mistaken or hostile value (a shared or production database) is refused without being contacted.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function assertLoopbackPgUrl(raw, name = 'database URL') {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${name} is not a valid URL; refusing to use it`); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`${name} must be a postgres:// URL; refusing to use it`);
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error(`${name} must point at a loopback host (127.0.0.1, localhost or ::1), got "${u.hostname}"; refusing to contact it`);
  // pg honours query parameters such as ?host= or ?hostaddr= that would override the host above, so none are accepted.
  if (u.search || u.hash) throw new Error(`${name} must not carry query parameters or a fragment; refusing to use it`);
  return raw;
}

// Used by `npm run test:all` before anything else runs: validates whichever database URLs are set.
export function checkEnvUrls(env = process.env) {
  const checked = [];
  for (const name of ['BB_PG_URL', 'TEST_DATABASE_URL']) {
    if (env[name] !== undefined) { assertLoopbackPgUrl(env[name], name); checked.push(name); }
  }
  return checked;
}
