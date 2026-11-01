// Upload state for the child's page, kept outside the view so re-rendering never loses the chosen photo.
//
// - One selection = one File + one idempotency key. A failed or lost-response attempt keeps both, so Retry resends
//   the same photo with the same key and the server returns the original upload instead of a duplicate.
// - A new selection (camera or library) gets a new key. An empty selection (the picker was cancelled) changes nothing,
//   so a previously failed photo stays retryable.
// - One attempt at a time, covering both preparing (resize) and sending. Actions while busy are ignored.
// - Nothing is persisted: a reload starts over, by design.
// - After a success the selection is cleared, so choosing the same photo again is a deliberate new upload.
import { createKeyHolder } from './upload-key.js';

export const STATUS = Object.freeze({ IDLE: 'idle', SELECTED: 'selected', PREPARING: 'preparing', UPLOADING: 'uploading', FAILED: 'failed', DONE: 'done' });

export function createUploadFlow({ prepare, send, onChange = () => {}, keyGen } = {}) {
  const keys = createKeyHolder(keyGen);
  let seq = 0;
  let state = { status: STATUS.IDLE, file: null, source: null, key: null, error: null, result: null };
  const set = (patch) => { state = { ...state, ...patch }; onChange(state); };
  const busy = () => state.status === STATUS.PREPARING || state.status === STATUS.UPLOADING;

  async function start() {
    if (busy() || !state.file) return false;
    const key = state.key;
    set({ status: STATUS.PREPARING, error: null });
    let body;
    try {
      body = await prepare(state.file);
    } catch {
      set({ status: STATUS.FAILED, error: 'prepare_failed' });
      return false;
    }
    set({ status: STATUS.UPLOADING });
    let r;
    try {
      r = await send(body, key);
    } catch {
      r = { ok: false, status: 0, body: { error: 'network' } };
    }
    if (r.ok) {
      keys.succeeded();
      set({ status: STATUS.DONE, file: null, source: null, key: null, error: null, result: r.body });
      return true;
    }
    set({ status: STATUS.FAILED, error: (r.body && r.body.error) || (r.status ? `http_${r.status}` : 'network'), httpStatus: r.status });
    return false;
  }

  return {
    get state() { return state; },
    busy,
    // source: 'camera' starts at once; 'library' waits for an explicit upload.
    select(file, source) {
      if (busy()) return false; // single flight: ignore new selections while preparing or sending
      if (!file) return false; // cancelled picker: keep whatever was there (including a retryable failure)
      seq += 1;
      const key = keys.forFile(`selection-${seq}`); // every deliberate selection is a new upload intent
      set({ status: STATUS.SELECTED, file, source, key, error: null, result: null });
      if (source === 'camera') return start();
      return true;
    },
    upload: () => start(),
    retry: () => (state.status === STATUS.FAILED ? start() : false),
  };
}

// Plain-language messages for the child. Unknown codes fall back to a generic retryable message; codes are never shown.
const MESSAGES = {
  unsupported_format: "That photo type isn't supported. Please take the photo again, or choose a JPEG or PNG.",
  invalid_image: "That file couldn't be opened as a photo. Please take the photo again.",
  image_too_large_dimensions: 'That photo is too large. Please take it again or choose a smaller one.',
  image_too_large_after_encode: 'That photo is too large. Please take it again or choose a smaller one.',
  request_too_large: 'That photo is too large. Please take it again or choose a smaller one.',
  daily_limit: "You've sent the most pages allowed today. Please ask a parent.",
  unauthenticated: 'You were signed out. Please sign in again, then send the photo again.',
  forbidden: 'This account cannot send photos.',
  prepare_failed: "That photo couldn't be prepared. Please take it again or choose another.",
  network: "The photo didn't send. Check the connection, then try again.",
};
export function friendlyError(code) {
  return MESSAGES[code] || "The photo didn't send. Please try again.";
}
export const canRetry = (code) => !['unsupported_format', 'invalid_image', 'image_too_large_dimensions', 'image_too_large_after_encode', 'request_too_large', 'daily_limit', 'unauthenticated', 'forbidden', 'prepare_failed'].includes(code);
