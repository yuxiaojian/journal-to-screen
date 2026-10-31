import { loadConfig, validateAppOrigin } from './config.js';
import { createPgDb, migrate } from './db.js';
import { createPushSender } from './push.js';
import { createApp } from './app.js';

const config = loadConfig();
for (const k of ['DATABASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
  if (!process.env[k]) {
    console.error(`missing required config: ${k}`);
    process.exit(1);
  }
}
if (!/^(mailto:|https:)/.test(config.vapid.subject)) {
  console.error('VAPID_SUBJECT must start with mailto: or https:');
  process.exit(1);
}
if (config.requireHttps && !validateAppOrigin(config.appOrigin)) {
  console.error('APP_ORIGIN must be a canonical https origin (no path, userinfo or :443) in production');
  process.exit(1);
}
const db = await createPgDb(config);
await migrate(db);
const app = createApp({ db, config, pushSender: createPushSender(config) });
app.listen(config.port, () => console.log(`listening on ${config.port}`));
