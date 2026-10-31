// Hidden terminal prompts. The typed value is never echoed, never logged and never leaves this function except as the return value.
// Terminal state is always restored: on Enter, Ctrl-C, Ctrl-D, stream end, error, and on process exit/signals.
// Input and output are injectable so cancellation and restoration are tested without a real terminal.

export class PromptCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'PromptCancelled'; }
}

// Signals that end the process while a prompt is open. Each gets a handler ONLY while the prompt is active, so the default
// behavior (terminate) is preserved afterwards and handlers can never accumulate across prompts.
export const PROMPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_NUMBER = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export function askHidden(label, { input = process.stdin, output = process.stdout, hide = true, proc = process, onSignalExit = true } = {}) {
  return new Promise((resolve, reject) => {
    if (hide && !input.isTTY) return reject(new Error('tty_required')); // never read a secret from a pipe or file
    let buf = '';
    let done = false;
    let esc = 0; // 0 = normal, 1 = just saw ESC, 2 = inside a CSI/SS3 sequence (arrow keys, etc.)
    const wasRaw = !!input.isRaw;
    const restore = () => {
      try { if (input.isTTY && input.isRaw !== wasRaw) input.setRawMode(wasRaw); } catch { /* stream already closed */ }
      try { input.pause(); } catch { /* ignore */ }
    };
    // Restore the terminal FIRST, synchronously, then end the process the way the signal intended (128 + signal number).
    // The restore is bounded: setRawMode and pause are synchronous and wrapped, so a failure cannot prevent the exit.
    const signalHandlers = new Map();
    const detachSignals = () => { for (const [sig, h] of signalHandlers) proc.off(sig, h); signalHandlers.clear(); };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onErr);
      proc.off('exit', restore);
      detachSignals();
      restore();
      output.write('\n');
      fn(value);
    };
    const onSignal = (sig) => () => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onErr);
      proc.off('exit', restore);
      detachSignals();
      restore();
      try { output.write('\n'); } catch { /* output closed */ }
      reject(new PromptCancelled());
      if (onSignalExit) proc.exit(128 + SIGNAL_NUMBER[sig]);
    };
    const onEnd = () => finish(reject, new PromptCancelled());
    const onErr = () => finish(reject, new PromptCancelled());
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        // Drop whole terminal escape sequences (arrow keys, Home/End, bracketed paste markers) so none of their bytes leak into the value.
        if (esc === 1) { esc = c === '[' || c === 'O' ? 2 : 0; continue; }
        if (esc === 2) { if (c >= '@' && c <= '~') esc = 0; continue; }
        if (c === '\u001b') { esc = 1; continue; }
        if (c === '\u0003' || c === '\u0004') return finish(reject, new PromptCancelled()); // Ctrl-C / Ctrl-D
        if (c === '\r' || c === '\n') return finish(resolve, buf);
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c; // ignore other control characters
        if (buf.length > 4096) return finish(reject, new Error('input_too_long'));
      }
    };
    proc.on('exit', restore);
    for (const sig of PROMPT_SIGNALS) { const h = onSignal(sig); signalHandlers.set(sig, h); proc.on(sig, h); }
    output.write(label);
    try {
      if (input.isTTY) input.setRawMode(true);
      input.setEncoding?.('utf8');
      input.resume();
    } catch (e) { return finish(reject, e); }
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onErr);
  });
}

// A plain yes/no. Anything other than an explicit "y" or "yes" is NO.
export async function confirm(label, io) {
  const a = (await askHidden(label, { ...io, hide: false })).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}
