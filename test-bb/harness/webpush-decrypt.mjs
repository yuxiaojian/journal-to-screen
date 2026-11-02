// Test-side Web Push subscription keys and RFC 8291 (aes128gcm) payload decryption, so the suite can prove what the
// server actually put inside a push message. Independent of the app: standard crypto only.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function makeSubscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) };
}

// Fixed-width P-256 key encodings. Node's ECDH getPrivateKey() returns the scalar WITHOUT leading zero bytes, so
// about 1 key in 256 comes out 31 bytes (and rarer ones shorter); web-push requires exactly 32 and the server then
// refuses to start. Always left-pad to 32 (private) / 65 (uncompressed public), as web-push's own generator does.
export const fixedWidth = (buf, len) => {
  if (buf.length > len) throw new Error(`key longer than ${len} bytes`);
  return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
};

// privateScalar (optional, for tests) pins the private key, e.g. one with a leading zero byte.
export function makeVapidKeys({ privateScalar } = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (privateScalar) ecdh.setPrivateKey(privateScalar);
  else ecdh.generateKeys();
  const pub = fixedWidth(ecdh.getPublicKey(), 65);
  const priv = fixedWidth(ecdh.getPrivateKey(), 32);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) throw new Error('bb: generated VAPID key pair has the wrong shape');
  return { publicKey: b64u(pub), privateKey: b64u(priv) };
}

// Decrypts a single-record aes128gcm body. Returns the plaintext string.
export function decryptAes128gcm(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(data), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1; // strip padding
  if (plain[end] !== 2) throw new Error('bad record delimiter');
  return plain.subarray(0, end).toString('utf8');
}
