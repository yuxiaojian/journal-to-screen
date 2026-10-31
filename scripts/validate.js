#!/usr/bin/env node
// Journal reading validation harness (local, interactive). See docs/validation.md.
//
//   node scripts/validate.js              dry run (default): offline, no key, no network, prints the exact production request summary
//   node scripts/validate.js --smoke      LIVE: two synthetic smoke calls (+ optional --injection), after typed consent
//   node scripts/validate.js --pages DIR --results FILE   LIVE: five private pages, only after a separate, later consent
//
// Safety: key via hidden TTY prompt only (never argv/env/file/log); fixed https://api.anthropic.com/v1/messages; no redirects;
// no automatic retries; at most 8 paid calls in ONE consented session; evidence is numbers and booleans only.
// There is deliberately no option or environment variable to change the endpoint, the model, the limits or the network.
import { PromptCancelled } from './validation/prompt.js';
import { REPO_ROOT } from './validation/guard.js';
import { productionSettings } from './validation/runner.js';
import { makeContext, dryRun, smoke, pages } from './validation/flows.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const KNOWN = new Set(['--smoke', '--pages', '--results', '--injection', '--help']);
for (const a of args) if (a.startsWith('--') && !KNOWN.has(a)) { console.error(`unknown option ${a}`); process.exit(2); }
if (flag('--help')) { console.log('usage: see docs/validation.md'); process.exit(0); }
if (args.some((a) => /^(sk-|ant-)/i.test(a))) { console.error('refusing: a key must never be passed as an argument'); process.exit(2); }

try {
  const c = makeContext({ settings: productionSettings({}), io: { input: process.stdin, output: process.stdout }, realFetch: fetch });
  if (flag('--pages')) await pages(c, { dir: val('--pages'), results: val('--results'), repoRoot: REPO_ROOT });
  else if (flag('--smoke')) await smoke(c, { injection: flag('--injection') });
  else await dryRun(c);
} catch (e) {
  if (e instanceof PromptCancelled) console.error('cancelled; terminal restored; nothing was sent after cancellation');
  else console.error(`stopped: ${String(e?.message || 'error').slice(0, 80).replace(/[^\x20-\x7e]/g, '?')}`);
  process.exitCode = 1;
}
