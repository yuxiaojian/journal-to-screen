import crypto from 'node:crypto';

export const ROLES = ['uploader', 'parent1', 'parent2'];
// Same format hashPassword() produces: scrypt$<16-byte salt b64>$<64-byte key b64>
const HASH_RE = /^scrypt\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/;

export function validateHashes(h) {
  if (!h || typeof h !== 'object') throw new Error('hashes must be an object');
  for (const r of ROLES) if (typeof h[r] !== 'string' || !HASH_RE.test(h[r])) throw new Error(`invalid hash format for ${r}`);
  if (new Set(ROLES.map((r) => h[r])).size !== ROLES.length) throw new Error('hashes must differ');
}

// Seeds one family with 3 users from already-hashed passwords. Refuses if any family exists.
export async function seedFromHashes(db, hashes) {
  validateHashes(hashes);
  return db.tx(async (t) => {
    if ((await t.query('SELECT 1 FROM families LIMIT 1')).rows.length) throw new Error('already seeded');
    const fid = crypto.randomUUID();
    await t.query('INSERT INTO families (id, name) VALUES ($1,$2)', [fid, 'family']);
    for (const role of ROLES) {
      await t.query('INSERT INTO users (id, family_id, username, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), fid, role, role, hashes[role]]);
    }
    return fid;
  });
}
