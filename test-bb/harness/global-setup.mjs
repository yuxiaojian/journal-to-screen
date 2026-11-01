// Provides one real PostgreSQL 18 for the whole run. CI passes BB_PG_URL (a service container); locally a throwaway
// Docker container is started and removed in teardown. There is no PGlite or in-memory fallback.
import fs from 'node:fs';
import path from 'node:path';
import { startDockerPg, stopDockerPg, serverVersion } from './pg.mjs';
import { assertLoopbackPgUrl } from './local-url.mjs';

const STATE = path.join(process.cwd(), 'test-results', '.bb-pg.json');

export default async function globalSetup() {
  let url = process.env.BB_PG_URL;
  if (url !== undefined) assertLoopbackPgUrl(url, 'BB_PG_URL'); // before any contact
  let container = null;
  if (!url) {
    const pg = await startDockerPg();
    url = pg.url;
    container = pg.name;
    process.env.BB_PG_URL = url;
  }
  const version = await serverVersion(url);
  if (!/^18(\.|$)/.test(version)) throw new Error(`black-box suite requires PostgreSQL 18, got ${version}`);
  console.log(`[bb] PostgreSQL ${version}${container ? ' (local Docker)' : ' (provided)'}`);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ container }));
  return async () => {
    stopDockerPg(container);
    fs.rmSync(STATE, { force: true });
  };
}
