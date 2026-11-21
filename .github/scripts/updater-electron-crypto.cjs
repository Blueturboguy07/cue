// CI only (.github/workflows/updater-proof.yml). Not part of the app.
//
// Runs the update signature check under Electron's own Node (ELECTRON_RUN_AS_NODE=1), whose crypto is
// BoringSSL, not the runner's OpenSSL. It shows which BLAKE2b path the app takes (Node crypto or blakejs)
// and that Ed25519 verification works there: a good fixture signature passes, a changed byte fails.
//   node -e "require('electron')" > /dev/null   # the electron package downloads its binary on first use
//   ELECTRON_RUN_AS_NODE=1 "$(node -p "require('electron')")" .github/scripts/updater-electron-crypto.cjs [minisign-vectors]
// With a folder argument it also verifies signatures made by the reference `minisign` tool (the unit job
// makes them): <dir>/minisign.pub, <dir>/legacy/latest.yml(.sig) from `minisign -S -l` (Ed25519 over the
// file) and <dir>/prehashed/latest.yml(.sig) from `minisign -S` (Ed25519 over BLAKE2b-512 of the file).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const V = require('../../publik-update-verify.cjs');

const FX = path.join(__dirname, '..', '..', 'test', 'fixtures', 'update-feed');
const read = (n) => fs.readFileSync(path.join(FX, n));
const ABC = 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923';

let ok = true;
const check = (name, pass) => { console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); ok = ok && pass; };

console.log(`electron ${process.versions.electron || '(none)'}, node ${process.versions.node}, process.versions.openssl ${process.versions.openssl}`);
check('running under Electron', !!process.versions.electron);
console.log(`blake2b512 in this crypto: ${crypto.getHashes().includes('blake2b512')} -> the app uses ${V.NATIVE_BLAKE2B ? 'Node crypto' : 'blakejs'}`);
check('BLAKE2b-512("abc") (RFC 7693) on the app path', V.blake2b512(Buffer.from('abc')).toString('hex') === ABC);
const feed = read('latest.yml');
const sig = read('latest.yml.sig').toString('utf8');
const key = read('test-key.pub').toString('utf8');
let good = false;
try { good = V.verifyMinisign(feed, sig, key, { file: 'latest.yml' }).keyId === '3CBEF89FB8AA125F'; } catch (e) { console.log(e.message); }
check('a tauri signature verifies (Ed25519 in this crypto)', good);
const bad = Buffer.from(feed);
bad[7] ^= 1;
let refused = false;
try { V.verifyMinisign(bad, sig, key); } catch (e) { refused = e.code === V.ERROR_CODE; }
check('one changed byte is refused', refused);

const vectors = process.argv[2];
if (vectors) {
  const mpub = fs.readFileSync(path.join(vectors, 'minisign.pub'), 'utf8');
  for (const [form, want] of [['legacy', 'Ed'], ['prehashed', 'ED']]) {
    const f = fs.readFileSync(path.join(vectors, form, 'latest.yml'));
    const s = fs.readFileSync(path.join(vectors, form, 'latest.yml.sig'), 'utf8');
    let alg = null;
    try { alg = V.verifyMinisign(f, s, mpub, { file: 'latest.yml' }).algorithm; } catch (e) { console.log(`${form}: ${e.message}`); }
    check(`minisign ${form} signature ("${want}") verifies`, alg === want);
    const b = Buffer.from(f);
    b[b.length - 2] ^= 1;
    let no = false;
    try { V.verifyMinisign(b, s, mpub); } catch (e) { no = e.code === V.ERROR_CODE; }
    check(`minisign ${form}: one changed byte is refused`, no);
  }
}
process.exit(ok ? 0 : 1);
