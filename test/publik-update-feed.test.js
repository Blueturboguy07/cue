// scripts/publik-update-feed.cjs `write`, for cue's release files: two mac zips (x64 and arm64) and a
// Windows installer whose name has no version (cue-win-x64.exe). Runs the script as the release does.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'publik-update-feed.cjs');
const BASE = 'https://github.com/Blueturboguy07/cue/releases/download/v9.9.9/';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cue-feed-')); }
function run(args) { return spawnSync(process.execPath, [SCRIPT, 'write', '--app', 'cue', '--version', '9.9.9', '--download-base', BASE, ...args], { encoding: 'utf8' }); }
/** A stand-in for an NSIS installer: some bytes and a version resource string ProductVersion = <v>. */
function fakeExe(file, v) {
  fs.writeFileSync(file, Buffer.concat([crypto.randomBytes(300), Buffer.from('ProductVersion\0', 'utf16le'), Buffer.alloc(2), Buffer.from(`${v}\0`, 'utf16le'), crypto.randomBytes(300)]));
}
const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

test('latest-mac.yml lists the x64 zip first, then the arm64 zip, with absolute URLs and sha512', () => {
  const d = tmp();
  const arm = path.join(d, 'cue-9.9.9-mac-arm64.zip');
  const x64 = path.join(d, 'cue-9.9.9-mac-x64.zip');
  fs.writeFileSync(arm, crypto.randomBytes(1000));
  fs.writeFileSync(x64, crypto.randomBytes(1200));
  const r = run(['--mac-zip', arm, '--mac-zip', x64, '--out', path.join(d, 'feed')]);
  assert.equal(r.status, 0, r.stderr);
  const feed = fs.readFileSync(path.join(d, 'feed', 'latest-mac.yml'), 'utf8');
  assert.equal(feed, [
    "version: '9.9.9'",
    "publikApp: 'cue'",
    'files:',
    `  - url: '${BASE}cue-9.9.9-mac-x64.zip'`, `    sha512: '${sha512(x64)}'`, '    size: 1200',
    `  - url: '${BASE}cue-9.9.9-mac-arm64.zip'`, `    sha512: '${sha512(arm)}'`, '    size: 1000',
    `path: '${BASE}cue-9.9.9-mac-x64.zip'`,
    `sha512: '${sha512(x64)}'`,
    feed.split('\n')[11],
    '',
  ].join('\n'));
  assert.match(feed.split('\n')[11], /^releaseDate: '\d{4}-\d\d-\d\dT/);
});

test('cue-win-x64.exe (no version in the name) is accepted by its ProductVersion, and refused with another one', () => {
  const d = tmp();
  const exe = path.join(d, 'cue-win-x64.exe');
  fakeExe(exe, '9.9.9');
  const ok = run(['--win', exe, '--out', path.join(d, 'feed')]);
  assert.equal(ok.status, 0, ok.stderr);
  const feed = fs.readFileSync(path.join(d, 'feed', 'latest.yml'), 'utf8');
  assert.match(feed, new RegExp(`url: '${BASE}cue-win-x64\\.exe'`));
  assert.match(feed, new RegExp(`sha512: '${sha512(exe).replace(/[+/]/g, '\\$&')}'`));

  fakeExe(exe, '9.9.10'); // the version must match exactly, not as a prefix
  const bad = run(['--win', exe, '--out', path.join(d, 'feed2')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /its ProductVersion is \["9\.9\.10"\], not 9\.9\.9/);
  const zip = path.join(d, 'cue-9.9.8-mac-x64.zip');
  fs.writeFileSync(zip, 'x');
  const old = run(['--mac-zip', zip, '--out', path.join(d, 'feed3')]);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /does not carry the version 9\.9\.9/);
});
