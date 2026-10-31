import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPgliteDb, createPgDb, migrate } from '../src/db.js';

const real = !!process.env.TEST_DATABASE_URL;
const S = real ? 'PG' : 'pglite';
const sql = (f) => fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

test(`[${S}] upgrade path: migration 002 applies to a populated v7 schema, keeps every row, and is idempotent`, async () => {
  const db = real ? await createPgDb({ databaseUrl: process.env.TEST_DATABASE_URL, dbSsl: false }) : await createPgliteDb();
  if (real) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  // State of the deployed app: only 001 applied, with real-looking POC rows.
  await db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)');
  await db.exec(sql('001_init.sql'));
  await db.query("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')");
  const id = () => crypto.randomUUID();
  const [fam, up, par, u1, sub1] = [id(), id(), id(), id(), id()];
  await db.query("INSERT INTO families (id,name) VALUES ($1,'f')", [fam]);
  await db.query("INSERT INTO users (id,family_id,username,role,password_hash) VALUES ($1,$2,'u','uploader','h'),($3,$2,'p','parent1','h')", [up, fam, par]);
  await db.query("INSERT INTO uploads (id,family_id,uploader_id,idempotency_key,image,content_type,byte_size,expires_at) VALUES ($1,$2,$3,'keykeykey',$4,'image/jpeg',3, now()+interval '1 day')", [u1, fam, up, Buffer.from([1, 2, 3])]);
  await db.query("INSERT INTO subscriptions (id,user_id,endpoint,p256dh,auth) VALUES ($1,$2,'https://web.push.apple.com/x','p','a')", [sub1, par]);
  await db.query("INSERT INTO sends (id,upload_id,subscription_id,status) VALUES ($1,$2,$3,'accepted_by_push_service')", [id(), u1, sub1]);

  await migrate(db); // applies only 002
  const names = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(names, ['001_init.sql', '002_journal.sql']);
  // existing rows survive and get round 0
  const sends = (await db.query('SELECT status, round FROM sends')).rows;
  assert.deepEqual(sends, [{ status: 'accepted_by_push_service', round: 0 }]);
  assert.equal((await db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
  // the new unique key is (upload, subscription, round): a second round is allowed, a duplicate of a round is not
  await db.query("INSERT INTO sends (id,upload_id,subscription_id,status,round) VALUES ($1,$2,$3,'pending',1)", [id(), u1, sub1]);
  await assert.rejects(db.query("INSERT INTO sends (id,upload_id,subscription_id,status,round) VALUES ($1,$2,$3,'pending',1)", [id(), u1, sub1]));
  await assert.rejects(db.query("INSERT INTO sends (id,upload_id,subscription_id,status,round) VALUES ($1,$2,$3,'pending',0)", [id(), u1, sub1]));
  // new tables behave: attempts cap, status check, single job slot row, cascade from uploads
  await db.query("INSERT INTO journal_analyses (id,upload_id,family_id,status) VALUES ($1,$2,$3,'queued')", [id(), u1, fam]);
  await assert.rejects(db.query('UPDATE journal_analyses SET attempts = 3'));
  await assert.rejects(db.query("UPDATE journal_analyses SET status = 'bogus'"));
  assert.equal((await db.query('SELECT count(*)::int n FROM job_slot')).rows[0].n, 1);
  await assert.rejects(db.query('INSERT INTO job_slot (id) VALUES (2)'));
  await assert.rejects(db.query("INSERT INTO ai_budget_months (month, reserved_micro) VALUES ('2026-10', -1)"));
  await db.query('DELETE FROM uploads WHERE id = $1', [u1]);
  assert.equal((await db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM sends')).rows[0].n, 0);
  // re-running migrate is a no-op
  await migrate(db);
  assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
  await db.close();
});
