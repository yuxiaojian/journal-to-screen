import { loadConfig, validateAppOrigin } from './config.js';
import { createPgDb, migrate } from './db.js';
import { createPushSender } from './push.js';
import { createApp } from './app.js';
import { createAnthropicProvider, validateAiConfig } from './ai.js';
import { createJobRunner } from './jobs.js';

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
const pushSender = createPushSender(config);
// AI is disabled unless AI_ENABLED=1 AND a key is set AND the model/limits/reservation validate. No key => no paid call, ever.
let jobs = null;
if (config.ai.enabled) {
  const check = validateAiConfig(config.ai);
  if (!config.ai.apiKey || !check.ok) {
    console.error(`AI_ENABLED=1 but configuration is not usable (${config.ai.apiKey ? check.reason : 'no_key'}); AI stays off`);
  } else {
    const provider = createAnthropicProvider({
      apiKey: config.ai.apiKey, model: config.ai.model, maxOutputTokens: config.ai.maxOutputTokens, timeoutMs: config.ai.timeoutMs,
    });
    jobs = createJobRunner({ db, config, provider, pushSender });
  }
}
const app = createApp({ db, config, pushSender, jobs });
app.listen(config.port, () => {
  console.log(`listening on ${config.port}; ai=${jobs?.active ? 'on' : 'off'}`);
  jobs?.start();
});
