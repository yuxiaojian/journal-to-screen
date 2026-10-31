// Runs on Heroku (one-off dyno). Reads {"uploader":"scrypt$..","parent1":"..","parent2":".."} from STDIN.
// Only password HASHES arrive here, via stdin: nothing in argv, env or the command string. Never prints input.
import { loadConfig } from '../src/config.js';
import { createPgDb, migrate } from '../src/db.js';
import { seedFromHashes, validateHashes } from '../src/seed.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let hashes;
try {
  hashes = JSON.parse(raw);
} catch {
  console.error('stdin is not valid JSON');
  process.exit(1);
}
// Validate BEFORE any database connection: malformed input fails fast and touches nothing.
try {
  validateHashes(hashes);
} catch (e) {
  console.error('seed failed:', e.message); // names the role/rule only, never the value
  process.exit(1);
}
const db = await createPgDb(loadConfig());
try {
  await migrate(db);
  await seedFromHashes(db, hashes);
  console.log('seeded users: uploader, parent1, parent2');
} catch (e) {
  console.error('seed failed:', e.message); // messages never include hash values
  process.exitCode = 1;
} finally {
  await db.close();
}
