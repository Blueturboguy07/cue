'use strict';
// publik-update-verify.cjs — checks a minisign signature with the publik update public key.
// The updater (publik-updater.cjs) runs it on every feed file (latest.yml, latest-mac.yml) before
// electron-updater may read the feed. The release script (scripts/publik-update-feed.cjs) runs it on
// each signature it makes. Plain Node: no Electron, so the unit tests can load it.
//
// The format is minisign's (https://jedisct1.github.io/minisign/), as written by `tauri signer sign`,
// `minisign` and `rsign2`:
//   public key line   base64( "Ed" | key ID, 8 bytes | Ed25519 public key, 32 bytes )
//   signature line    base64( "ED" | key ID, 8 bytes | Ed25519 signature, 64 bytes )
//                       "ED": the signature is over BLAKE2b-512(file) (the default since minisign 0.8)
//                       "Ed": the signature is over the file itself (legacy minisign)
//   trusted comment   one line of text, e.g. "timestamp:1795027337\tfile:latest.yml"
//   global signature  base64( Ed25519 signature, 64 bytes, over: signature bytes | trusted comment )
// `tauri signer` wraps the whole key file and the whole signature file in one more layer of base64.
// Both forms are accepted here.

const crypto = require('node:crypto');

/** The publik update public key (made with `tauri signer generate`, key ID F5E0515C77912BD0). Public: safe to commit. */
const PUBLIK_UPDATE_PUBLIC_KEY = 'RWTQK5F3XFHg9dSCe0hbyVnoM4pWgy73MdD+Yf1IMZntgXKasqdYRcYv';
/**
 * Every key the app accepts. One key, except during a key rotation: then a release carries the old key
 * and the new key, so the feed can move to the new key later (docs/updates.md › Rotate the key).
 */
const PUBLIK_UPDATE_PUBLIC_KEYS = [PUBLIK_UPDATE_PUBLIC_KEY];

const ERROR_CODE = 'ERR_PUBLIK_UPDATE_SIGNATURE';
const MAX_SIGNATURE_TEXT = 4096;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(message) {
  const e = new Error(message);
  e.code = ERROR_CODE;
  return e;
}

function strictBase64(text, what) {
  const s = String(text).trim();
  if (!s || s.length % 4 !== 0 || !BASE64.test(s)) throw fail(`${what} is not valid base64`);
  return Buffer.from(s, 'base64');
}

function asText(input, what) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (!text.trim()) throw fail(`${what} is empty`);
  if (text.length > MAX_SIGNATURE_TEXT) throw fail(`${what} is too long`);
  return text.replace(/\r\n/g, '\n').trim();
}

/** Takes minisign file text, or that text wrapped in base64 (tauri). Returns the minisign text. */
function unwrap(input, what) {
  const text = asText(input, what);
  if (text.startsWith('untrusted comment:')) return text;
  if (/\s/.test(text)) throw fail(`${what} is neither minisign text nor base64`);
  const inner = strictBase64(text, what).toString('utf8').replace(/\r\n/g, '\n').trim();
  if (!inner.startsWith('untrusted comment:')) return null; // base64 that is not a wrapped file
  return inner;
}

/** The key ID as minisign prints it (little-endian hex), for messages. */
function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

/**
 * Parses a public key: the bare key line ("RW..."), the two-line minisign .pub file, or that file
 * wrapped in base64 (tauri's .pub). Returns { keyId: Buffer(8), publicKey: Buffer(32) }.
 */
function parsePublicKey(input) {
  const text = asText(input, 'public key');
  let line = text;
  if (text.startsWith('untrusted comment:')) {
    line = text.split('\n')[1] || '';
  } else {
    const inner = unwrap(text, 'public key');
    if (inner) line = inner.split('\n')[1] || '';
  }
  const raw = strictBase64(line, 'public key');
  if (raw.length !== 42) throw fail(`public key has ${raw.length} bytes, want 42`);
  if (raw.subarray(0, 2).toString('latin1') !== 'Ed') throw fail('public key is not an Ed25519 minisign key');
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

/**
 * Parses a signature file (.sig): minisign text, or that text wrapped in base64 (tauri).
 * Returns { algorithm: 'ED' | 'Ed', keyId, signature, trustedComment, globalSignature }.
 */
function parseSignature(input) {
  const text = unwrap(input, 'signature');
  if (!text) throw fail('signature is not a minisign signature');
  const lines = text.split('\n');
  if (lines.length !== 4) throw fail(`signature has ${lines.length} lines, want 4`);
  const [untrusted, sigLine, trustedLine, globalLine] = lines;
  if (!untrusted.startsWith('untrusted comment:')) throw fail('signature has no untrusted comment line');
  const raw = strictBase64(sigLine, 'signature line');
  if (raw.length !== 74) throw fail(`signature line has ${raw.length} bytes, want 74`);
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw fail(`unknown signature algorithm "${algorithm}"`);
  if (!trustedLine.startsWith('trusted comment: ')) throw fail('signature has no trusted comment line');
  const globalSignature = strictBase64(globalLine, 'global signature');
  if (globalSignature.length !== 64) throw fail(`global signature has ${globalSignature.length} bytes, want 64`);
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: trustedLine.slice('trusted comment: '.length),
    globalSignature,
  };
}

/**
 * BLAKE2b-512. Node's crypto has it (OpenSSL); Electron's crypto (BoringSSL) does not, so the app
 * falls back to blakejs, a small pure-JS BLAKE2b. The unit tests check both give the same digest.
 */
const NATIVE_BLAKE2B = crypto.getHashes().includes('blake2b512');
function blake2b512(data, { native = NATIVE_BLAKE2B } = {}) {
  if (native) return crypto.createHash('blake2b512').update(data).digest();
  return Buffer.from(require('blakejs').blake2b(data, undefined, 64));
}

function ed25519Verify(publicKey, message, signature) {
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  return crypto.verify(null, message, key, signature);
}

/** "timestamp:1795027337\tfile:latest.yml" -> { timestamp: '1795027337', file: 'latest.yml' } */
function parseTrustedComment(comment) {
  const out = {};
  for (const part of comment.split('\t')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/**
 * Verifies `message` (Buffer) against the signature file text `signatureText` with a public key, or
 * with the one key of a list whose key ID the signature names (default: PUBLIK_UPDATE_PUBLIC_KEYS).
 * With `file`, the trusted comment must name that file (tauri, minisign and rsign2 write
 * "file:<name>" there), so a signature made for latest-mac.yml cannot pass for latest.yml.
 * Returns the parsed details; throws an Error with code ERR_PUBLIK_UPDATE_SIGNATURE on any mismatch.
 */
function verifyMinisign(message, signatureText, publicKeys = PUBLIK_UPDATE_PUBLIC_KEYS, { file } = {}) {
  if (!Buffer.isBuffer(message)) throw fail('message must be a Buffer');
  const keys = (Array.isArray(publicKeys) ? publicKeys : [publicKeys]).map(parsePublicKey);
  if (keys.length === 0) throw fail('no public key');
  const sig = parseSignature(signatureText);
  const key = keys.find((k) => k.keyId.equals(sig.keyId));
  if (!key) {
    throw fail(`signed with key ${keyIdHex(sig.keyId)}, not with the update key ${keys.map((k) => keyIdHex(k.keyId)).join(' or ')}`);
  }
  const signed = sig.algorithm === 'ED' ? blake2b512(message) : message;
  if (!ed25519Verify(key.publicKey, signed, sig.signature)) throw fail('signature does not match the file');
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!ed25519Verify(key.publicKey, globalMessage, sig.globalSignature)) throw fail('trusted comment signature does not match');
  const comment = parseTrustedComment(sig.trustedComment);
  if (file != null && comment.file !== file) {
    throw fail(`signature is for "${comment.file ?? '(no file name)'}", not for "${file}"`);
  }
  return { keyId: keyIdHex(sig.keyId), algorithm: sig.algorithm, trustedComment: sig.trustedComment, ...comment };
}

module.exports = {
  PUBLIK_UPDATE_PUBLIC_KEY,
  PUBLIK_UPDATE_PUBLIC_KEYS,
  ERROR_CODE,
  NATIVE_BLAKE2B,
  verifyMinisign,
  parsePublicKey,
  parseSignature,
  parseTrustedComment,
  blake2b512,
  keyIdHex,
};
