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
import dgram from 'node:dgram';

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

// Raw sockets: allow loopback (Postgres, the fake server) and local socket paths only. Every TCP/TLS client
// connection in Node, including `new net.Socket().connect(...)`, http/https agents and tls.connect, goes through
// net.Socket.prototype.connect, so guarding it closes all of those entry points. The wrappers on net.connect /
// net.createConnection / tls.connect are kept as an earlier, clearer failure.
function hostOf(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // internal normalized form: [options, cb]
  if (a !== null && typeof a === 'object') {
    if (a.path) return { path: true };
    return { host: a.host || a.hostname || 'localhost' };
  }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: true }; // connect(path)
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost' }; // connect(port, host)
}
const guardConnect = (orig, label) => function guarded(...args) {
  const t = hostOf(args);
  if (!t.path && !LOOPBACK.has(t.host)) throw blocked(`${label} ${t.host}`);
  return orig.apply(this, args);
};
net.Socket.prototype.connect = guardConnect(net.Socket.prototype.connect, 'socket');
net.connect = guardConnect(net.connect, 'net');
net.createConnection = guardConnect(net.createConnection, 'net');
tls.connect = guardConnect(tls.connect, 'tls');

// UDP: only loopback destinations.
const dgramGuard = (orig) => function guardedSend(...args) {
  const host = args.find((x, i) => i > 0 && typeof x === 'string');
  if (host && !LOOPBACK.has(host)) throw blocked(`udp ${host}`);
  return orig.apply(this, args);
};
dgram.Socket.prototype.send = dgramGuard(dgram.Socket.prototype.send);
dgram.Socket.prototype.connect = (function wrap(orig) {
  return function guardedUdpConnect(port, host, ...rest) {
    if (typeof host === 'string' && !LOOPBACK.has(host)) throw blocked(`udp ${host}`);
    return orig.call(this, port, host, ...rest);
  };
}(dgram.Socket.prototype.connect));

console.log('net-fakes: active (loopback only; AI and push redirected to fake)');
