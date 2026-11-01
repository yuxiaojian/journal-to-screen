// TEST-ONLY network boundary for the black-box suite. It is loaded into the server process exclusively by the
// harness (`node --import <this file> src/server.js`); production never loads it and nothing in src/ references it.
//
// - Outbound HTTPS to the Anthropic API and to the allowed Web Push hosts is redirected to the local fake control
//   server named by BB_FAKE_URL (loopback only).
// - Every other outbound connection that is not loopback fails closed, so an accidental real network call (paid AI,
//   real push service, anything else) makes the test fail instead of leaving the machine.
// - The process refuses to start at all unless BB_FAKE_URL points at 127.0.0.1, so this file cannot be used to
//   send traffic anywhere else.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const FAKE = process.env.BB_FAKE_URL || '';
const fakeUrl = (() => { try { return new URL(FAKE); } catch { return null; } })();
if (!fakeUrl || fakeUrl.protocol !== 'http:' || fakeUrl.hostname !== '127.0.0.1') {
  console.error('net-fakes: BB_FAKE_URL must be http://127.0.0.1:<port>; refusing to start');
  process.exit(97);
}

const AI_HOST = 'api.anthropic.com';
const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const blocked = (what) => {
  const e = new Error(`net-fakes: blocked outbound ${what}`);
  e.code = 'BB_EGRESS_BLOCKED';
  console.error(e.message);
  return e;
};

// fetch(): used by the Anthropic provider.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (u.hostname === AI_HOST) {
    const target = new URL(`/ai${u.pathname}`, fakeUrl);
    return realFetch(target, init);
  }
  if (LOOPBACK.has(u.hostname)) return realFetch(input, init);
  throw blocked(`fetch ${u.hostname}`);
};

// https.request(): used by web-push. Push hosts go to the fake over plain http; everything else non-loopback is blocked.
const realHttpsRequest = https.request;
https.request = function patchedRequest(options, cb) {
  const host = typeof options === 'string' ? new URL(options).hostname : (options.hostname || options.host);
  if (PUSH_HOSTS.has(host)) {
    const o = typeof options === 'string' ? new URL(options) : options;
    return http.request({
      hostname: fakeUrl.hostname, port: fakeUrl.port, method: o.method || 'POST',
      path: `/push/${host}${o.path || o.pathname || '/'}`, headers: o.headers, timeout: o.timeout,
    }, cb);
  }
  if (LOOPBACK.has(host)) return realHttpsRequest.apply(this, arguments);
  throw blocked(`https ${host}`);
};
https.get = function patchedGet(...args) { const r = https.request(...args); r.end(); return r; };

// Raw sockets: allow loopback (Postgres, the fake server) only.
const guardConnect = (orig, label) => function guarded(...args) {
  const a = args[0];
  const host = typeof a === 'object' && a !== null ? (a.host || a.hostname || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  const isPath = typeof a === 'object' && a !== null && a.path;
  if (!isPath && !LOOPBACK.has(host)) throw blocked(`${label} ${host}`);
  return orig.apply(this, args);
};
net.connect = guardConnect(net.connect, 'net');
net.createConnection = guardConnect(net.createConnection, 'net');
tls.connect = guardConnect(tls.connect, 'tls');

console.log('net-fakes: active (loopback only; AI and push redirected to fake)');
