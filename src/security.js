import crypto from 'node:crypto';

const scrypt = (pw, salt) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export const MIN_PASSWORD_LEN = 12;
export const MAX_PASSWORD_LEN = 200; // verifyPassword rejects longer values, so seeding must never accept them

// Single rule shared by seeding and login. Returns an error string, or null when acceptable.
export function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Password must be text.';
  if (pw.length < MIN_PASSWORD_LEN) return `Too short (minimum ${MIN_PASSWORD_LEN}).`;
  if (pw.length > MAX_PASSWORD_LEN) return `Too long (maximum ${MAX_PASSWORD_LEN}).`;
  return null;
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

let dummy;
export async function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || pw.length > MAX_PASSWORD_LEN) return false;
  if (!stored) {
    // Unknown user: do equivalent work so timing does not reveal existence.
    dummy ??= await hashPassword('dummy-password');
    stored = dummy;
    await verifyPassword(pw, stored);
    return false;
  }
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(k, 'base64');
  const actual = await scrypt(pw, Buffer.from(s, 'base64'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const newId = () => crypto.randomUUID();
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
