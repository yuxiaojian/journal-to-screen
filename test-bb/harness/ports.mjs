// Port allocation for servers the black-box suite starts. Allocating an ephemeral port (listen on 0, close, hand the
// number to a child) leaves a gap in which the OS can give that same number to any other outgoing connection; on a
// busy machine (VPN agents, browsers) that happened often, and the server then could not bind.
//
// Instead each Playwright worker gets its own block of ports BELOW the OS ephemeral range, so the OS never hands
// them out as source ports. This does not make collisions impossible (another program may deliberately listen
// there); a collision makes the server exit with EADDRINUSE and the test fails clearly. There is no retry.
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

export const BASE = 20000;
export const BLOCK = 400;
export const MAX_WORKERS = 16;

// The OS ephemeral range: macOS sysctl, Linux /proc. Unknown platforms fall back to the IANA range.
export function ephemeralRange() {
  try {
    const t = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (t.length === 2 && t.every(Number.isInteger)) return { first: t[0], last: t[1], source: 'linux' };
  } catch { /* not linux */ }
  try {
    const first = Number(execFileSync('sysctl', ['-n', 'net.inet.ip.portrange.first'], { encoding: 'utf8' }).trim());
    const last = Number(execFileSync('sysctl', ['-n', 'net.inet.ip.portrange.last'], { encoding: 'utf8' }).trim());
    if (Number.isInteger(first) && Number.isInteger(last)) return { first, last, source: 'sysctl' };
  } catch { /* not macOS */ }
  return { first: 49152, last: 65535, source: 'default' };
}

export function workerBlock(index = Number(process.env.TEST_PARALLEL_INDEX || 0)) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_WORKERS) throw new Error(`bb ports: worker index ${index} outside 0..${MAX_WORKERS - 1}`);
  const first = BASE + index * BLOCK;
  return { first, last: first + BLOCK - 1 };
}

// Fails at load if the configured blocks overlap this machine's ephemeral range.
export function assertOutsideEphemeral(range = ephemeralRange()) {
  const top = BASE + MAX_WORKERS * BLOCK - 1;
  if (!(top < range.first || BASE > range.last)) {
    throw new Error(`bb ports: blocks ${BASE}-${top} overlap the OS ephemeral range ${range.first}-${range.last} (${range.source})`);
  }
  return { blocks: [BASE, top], ephemeral: range };
}

const isFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port, host: '::', ipv6Only: false }, () => s.close(() => resolve(true)));
});

let cursor = 0;
// Next free port in this worker's block. Skips ports something else is already listening on (that is allocation,
// not a retry); throws once the whole block has been tried.
export async function nextPort() {
  const { first } = workerBlock();
  for (let tried = 0; tried < BLOCK; tried += 1) {
    const port = first + (cursor % BLOCK);
    cursor += 1;
    if (await isFree(port)) return port;
  }
  throw new Error(`bb ports: no free port left in worker block starting at ${first}`);
}
