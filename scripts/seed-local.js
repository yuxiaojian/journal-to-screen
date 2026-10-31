// Run LOCALLY by the parent: node scripts/seed-local.js [--dry-run]
// Prompts (hidden input, TTY required) for the 3 passwords, hashes them locally with the app's scrypt format,
// then pipes ONLY the hashes over stdin to a one-off Heroku dyno. Passwords never touch argv, env, files, shell
// history, Heroku command metadata or chat. --dry-run hashes and validates but sends nothing.
import { spawn } from 'node:child_process';
import { hashPassword, passwordProblem } from '../src/security.js';
import { ROLES, validateHashes } from '../src/seed.js';

const APP = 'stm-relay';
const dry = process.argv.includes('--dry-run');
if (!process.stdin.isTTY) {
  console.error('Run this in an interactive terminal (hidden password prompts need a TTY).');
  process.exit(1);
}

// Always leave the terminal usable: restore cooked mode on exit and on interrupt/terminate.
const restoreTty = () => { try { if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false); } catch { /* already closed */ } };
process.on('exit', restoreTty);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreTty(); process.stdout.write('\n'); process.exit(130); });

function askHidden(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\u0003') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return reject(new Error('cancelled')); }
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const hashes = {};
const seen = new Set();
for (const role of ROLES) {
  for (;;) {
    const a = await askHidden(`Password for ${role} (12-200 chars): `);
    const problem = passwordProblem(a);
    if (problem) { console.log(problem); continue; }
    if (seen.has(a)) { console.log('Use a different password for each user.'); continue; }
    const b = await askHidden('Confirm: ');
    if (a !== b) { console.log('Did not match, try again.'); continue; }
    seen.add(a);
    hashes[role] = await hashPassword(a);
    break;
  }
}
validateHashes(hashes);
if (dry) {
  console.log('Dry run OK: 3 valid hashes computed locally. Nothing sent.');
  process.exit(0);
}
console.log(`Sending hashes to ${APP} over stdin...`);
const child = spawn('heroku', ['run', '-a', APP, '--no-tty', '--size=basic', 'node scripts/seed-hashed.js'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(JSON.stringify(hashes));
child.on('exit', (code) => process.exit(code ?? 1));
