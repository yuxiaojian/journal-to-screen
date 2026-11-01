// First step of `npm run test:all`: refuse to run any suite against a non-loopback database URL.
import { checkEnvUrls } from './local-url.mjs';

try {
  const checked = checkEnvUrls();
  console.log(`[bb] database URLs are loopback-only (${checked.length ? checked.join(', ') : 'none set'})`);
} catch (e) {
  console.error(`[bb] ${e.message}`);
  process.exit(1);
}
