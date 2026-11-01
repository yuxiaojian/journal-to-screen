// Fake external services (one instance per test), on 127.0.0.1 only:
//   POST /ai/v1/messages           -> fake Anthropic Messages API, scripted per call
//   POST /push/<host>/<path>       -> fake Web Push service, records every request, scripted status
// The server under test reaches these only through test-bb/harness/net-fakes.mjs.
import http from 'node:http';

const TOOL = 'record_transcript';

// The response shape matches the live Messages API tool_use reply observed in the owner-run smoke check.
export function aiToolReply(input, { model = 'claude-haiku-5-5', stopReason = 'tool_use' } = {}) {
  return {
    id: 'msg_bb_fake', type: 'message', role: 'assistant', model, stop_reason: stopReason, stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_bb_fake', name: TOOL, input }],
    usage: { input_tokens: 1781, output_tokens: 100 },
  };
}

// Script items for the AI fake:
//   { transcript, illegible_count?, page_issues? }  -> valid tool_use reply
//   { status: 500 }                                -> HTTP error
//   { invalid: true }                              -> 200 with a tool input that fails the app's schema
//   { hold: true }                                 -> response withheld until release() (or the client aborts)
//   { hang: true }                                 -> never answered; only the client's own deadline ends it
export async function startFakes() {
  const aiScript = [];
  const aiCalls = []; // { at, body }
  const pushes = []; // { at, host, path, headers, body: Buffer }
  const pushStatus = new Map(); // path -> status for that endpoint (default 201)
  const holds = [];
  let defaultAi = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/ai/v1/messages') return handleAi(req, res, body);
      if (req.method === 'POST' && req.url.startsWith('/push/')) {
        const rest = req.url.slice('/push/'.length);
        const host = rest.split('/')[0];
        const path = rest.slice(host.length);
        pushes.push({ at: Date.now(), host, path, headers: req.headers, body });
        const status = pushStatus.get(path) ?? 201;
        res.writeHead(status, { 'content-type': 'text/plain' });
        return res.end(status < 300 ? '' : 'fake push error');
      }
      res.writeHead(404); res.end();
    });
  });

  function handleAi(req, res, body) {
    let parsed = null;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { /* recorded as null */ }
    aiCalls.push({ at: Date.now(), body: parsed, apiKeyHeader: req.headers['x-api-key'] });
    const item = aiScript.length ? aiScript.shift() : defaultAi;
    if (!item) { res.writeHead(500); return res.end('{"type":"error"}'); }
    const respond = (it) => {
      if (res.writableEnded || res.destroyed) return;
      if (it.status) { res.writeHead(it.status, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"api_error"}}'); }
      const input = it.invalid
        ? { transcript: 'x', illegible_count: 'not-a-number', page_issues: [] }
        : { transcript: it.transcript, illegible_count: it.illegible_count ?? 0, page_issues: it.page_issues ?? [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(aiToolReply(input)));
    };
    if (item.hang) return; // never answered
    if (item.hold) { holds.push(() => respond(item.then || { transcript: item.transcript ?? 'held page' })); return; }
    respond(item);
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    aiCalls,
    pushes,
    scriptAi: (...items) => aiScript.push(...items),
    setDefaultAi: (item) => { defaultAi = item; },
    setPushStatus: (path, status) => pushStatus.set(path, status),
    releaseHolds: () => { while (holds.length) holds.shift()(); },
    pushesTo: (path) => pushes.filter((p) => p.path === path),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
