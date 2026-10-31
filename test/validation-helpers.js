import { PassThrough } from 'node:stream';
import { createSession, ENDPOINT } from '../scripts/validation/guard.js';
import { productionSettings } from '../scripts/validation/runner.js';

export const settings = productionSettings({});
export const bounds = { model: settings.ai.model, inputTokenBound: settings.check.inputTokenBound, maxOutputTokens: settings.ai.maxOutputTokens };
export const newSession = (extra = {}) => { const s = createSession({ bounds, ...extra }); s.grantConsent(); return s; };

// A scripted fake of the network. NEVER touches a real socket.
export function fakeNet(script = []) {
  const calls = [];
  const net = async (url, init) => {
    calls.push({ url, init });
    const next = script.length ? script.shift() : good();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  net.calls = calls;
  return net;
}
export const toolInput = (n, extra = {}) => ({ transcript: Array.from({ length: n }, () => 'cat').join(' '), illegible_count: 0, page_issues: [], ...extra });
export function good(input = toolInput(19), { usage = { input_tokens: 900, output_tokens: 80 }, model = settings.ai.model, stop = 'tool_use', status = 200 } = {}) {
  const body = { model, stop_reason: stop, usage, content: [{ type: 'tool_use', id: 't', name: 'record_transcript', input }] };
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// A fake terminal stream for the prompt tests.
export function fakeTty({ isTTY = true } = {}) {
  const s = new PassThrough();
  s.isTTY = isTTY;
  s.isRaw = false;
  s.rawCalls = [];
  s.setRawMode = (m) => { s.rawCalls.push(m); s.isRaw = m; return s; };
  return s;
}
export const sink = () => { const chunks = []; return { write: (x) => { chunks.push(String(x)); return true; }, chunks, text: () => chunks.join('') }; };
export { ENDPOINT };
