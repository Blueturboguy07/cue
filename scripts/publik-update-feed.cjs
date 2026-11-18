#!/usr/bin/env node
// publik-update-feed.cjs — makes the signed update feed of a release (docs/updates.md).
//
//   write    latest.yml (Windows) and/or latest-mac.yml (macOS) for files on disk, with ABSOLUTE
//            download URLs (the GitHub release assets):
//              node scripts/publik-update-feed.cjs write --app cue --version 0.2.16 \
//                --download-base https://github.com/OWNER/REPO/releases/download/v0.2.16/ \
//                --win dist/cue-win-x64.exe \
//                --mac-zip dist/cue-0.2.16-mac-x64.zip --mac-zip dist/cue-0.2.16-mac-arm64.zip --out feed
//            --mac-zip may be given once per architecture (cue ships an x64 zip and an arm64 zip;
//            electron-updater picks the zip whose URL has "arm64" on Apple silicon and the other one on
//            Intel). A file name must carry the version, except a Windows installer whose version
//            resource (ProductVersion) does: cue's installer is always called cue-win-x64.exe.
//   sign     signs each file with the publik update key (writes <file>.sig), then verifies the signature
//            with the public key in publik-update-verify.cjs. The key comes from the environment:
//            PUBLIK_UPDATE_KEY (the private key as `tauri signer generate` wrote it) and
//            PUBLIK_UPDATE_KEY_PASSWORD. It is never printed.
//              node scripts/publik-update-feed.cjs sign feed/latest.yml feed/latest-mac.yml
//   verify   checks <file> against <file>.sig with the publik update public key (or --public-key).
//   release  the CI path (.github/workflows/update-feed.yml): for the GitHub release --tag, makes every
//            feed file that is missing (all of them with --force) from the installer files on the
//            release, signs it, verifies it and uploads it. Uses the gh CLI.
//              node scripts/publik-update-feed.cjs release --tag v0.2.16 --app cue [--repo OWNER/REPO] [--version 0.2.16] [--force]
//
// A feed file is what electron-updater reads (version, files[] with url + sha512 + size, path, sha512,
// releaseDate), plus `publikApp: <slug>`: the app refuses a feed made for another app.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../publik-update-verify.cjs');

const TAURI_CLI = '@tauri-apps/cli@2.12.4';

function die(msg) {
  console.error(`publik-update-feed: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let value = true;
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
      // A flag given twice (--mac-zip x64.zip --mac-zip arm64.zip) becomes a list.
      opts[key] = key in opts ? [].concat(opts[key], value) : value;
    } else opts._.push(a);
  }
  return opts;
}

const list = (v) => (v == null || v === false ? [] : [].concat(v));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // a YAML single-quoted string

function fileEntry(file, downloadBase) {
  const data = fs.readFileSync(file);
  const name = path.basename(file);
  return {
    name,
    url: new URL(encodeURIComponent(name), downloadBase).href,
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
    size: data.length,
  };
}

/** The text of one feed file. The first entry is the one `path`/`sha512` name (electron-updater's legacy fields). */
function feedText({ app, version, entries, releaseDate }) {
  const lines = [`version: ${q(version)}`, `publikApp: ${q(app)}`, 'files:'];
  for (const e of entries) lines.push(`  - url: ${q(e.url)}`, `    sha512: ${q(e.sha512)}`, `    size: ${e.size}`);
  lines.push(`path: ${q(entries[0].url)}`, `sha512: ${q(entries[0].sha512)}`, `releaseDate: ${q(releaseDate)}`);
  return lines.join('\n') + '\n';
}

/** The ProductVersion strings in the version resource of a Windows executable (UTF-16LE, NUL-ended). */
function exeProductVersions(data) {
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const found = [];
  for (let i = data.indexOf(key); i !== -1; i = data.indexOf(key, i + 2)) {
    let j = i + key.length;
    while (j + 1 < data.length && data[j] === 0 && data[j + 1] === 0) j += 2; // padding
    let k = j;
    while (k + 1 < data.length && !(data[k] === 0 && data[k + 1] === 0)) k += 2;
    if (k > j && k - j < 256) found.push(data.subarray(j, k).toString('utf16le'));
  }
  return found;
}

function checkName(file, version, { exe = false } = {}) {
  if (path.basename(file).includes(version)) return;
  if (exe) {
    const versions = exeProductVersions(fs.readFileSync(file));
    if (versions.includes(version)) return;
    die(`${path.basename(file)}: its name has no version and its ProductVersion is ${JSON.stringify(versions)}, not ${version}: is it the right file?`);
  }
  die(`${path.basename(file)} does not carry the version ${version}: is it the right file?`);
}

/** x64 (or universal) before arm64: `path`/`sha512` name the first file, which runs on every Mac. */
const macOrder = (a, b) => Number(/arm64/.test(path.basename(a))) - Number(/arm64/.test(path.basename(b))) || a.localeCompare(b);

function write(opts) {
  const { app, version, out } = opts;
  const base = opts['download-base'];
  if (!app || !version || !base || !out) die('write needs --app, --version, --download-base and --out');
  if (!/^https:\/\//.test(base)) die('--download-base must be an https URL');
  const downloadBase = base.endsWith('/') ? base : `${base}/`;
  const releaseDate = opts['release-date'] || new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  if (list(opts.win).length > 1) die('give one --win installer');
  if (opts.win) {
    checkName(opts.win, version, { exe: true });
    const text = feedText({ app, version, entries: [fileEntry(opts.win, downloadBase)], releaseDate });
    fs.writeFileSync(path.join(out, 'latest.yml'), text);
    written.push(path.join(out, 'latest.yml'));
  }
  const zips = list(opts['mac-zip']).sort(macOrder);
  if (zips.length) {
    for (const z of zips) checkName(z, version);
    const entries = zips.map((z) => fileEntry(z, downloadBase)); // the zips first: Squirrel.Mac installs from one
    for (const d of list(opts['mac-dmg'])) { checkName(d, version); entries.push(fileEntry(d, downloadBase)); }
    fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText({ app, version, entries, releaseDate }));
    written.push(path.join(out, 'latest-mac.yml'));
  } else if (opts['mac-dmg']) {
    die('--mac-dmg needs --mac-zip: macOS updates install from the zip');
  }
  if (!written.length) die('nothing to write: give --win and/or --mac-zip');
  for (const f of written) console.log(`publik-update-feed: wrote ${f}`);
  return written;
}

function publicKeyFrom(opts) {
  const k = opts['public-key'];
  if (!k || k === true) return PUBLIK_UPDATE_PUBLIC_KEYS;
  return fs.existsSync(k) ? fs.readFileSync(k, 'utf8') : k;
}

function verify(files, opts) {
  const key = publicKeyFrom(opts);
  for (const f of files) {
    const sigFile = `${f}.sig`;
    if (!fs.existsSync(sigFile)) die(`${sigFile} is missing`);
    try {
      const v = verifyMinisign(fs.readFileSync(f), fs.readFileSync(sigFile, 'utf8'), key, { file: path.basename(f) });
      console.log(`publik-update-feed: ${path.basename(sigFile)} OK (key ${v.keyId}, ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      die(`${path.basename(sigFile)} does not verify: ${e.message}`);
    }
  }
}

function sign(files, opts) {
  const key = process.env.PUBLIK_UPDATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY;
  const password = process.env.PUBLIK_UPDATE_KEY_PASSWORD ?? process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (!key) die('PUBLIK_UPDATE_KEY is not set');
  if (!password) die('PUBLIK_UPDATE_KEY_PASSWORD is not set');
  const env = { ...process.env, CI: 'true', TAURI_SIGNING_PRIVATE_KEY: key.trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  for (const f of files) {
    if (!fs.existsSync(f)) die(`${f} does not exist`);
    fs.rmSync(`${f}.sig`, { force: true });
    const r = spawnSync('npx', ['--yes', TAURI_CLI, 'signer', 'sign', f], { env, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    if (r.status !== 0 || !fs.existsSync(`${f}.sig`)) die(`signing ${f} failed (exit ${r.status})`);
  }
  verify(files, opts);
}

function gh(args, { json = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) die(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function release(opts) {
  const tag = opts.tag;
  const app = opts.app;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY;
  if (!tag || !app || !repo) die('release needs --tag, --app and --repo (or GITHUB_REPOSITORY)');
  const version = opts.version || tag.replace(/^v/, ''); // --version: when the tag is not v<version>
  const rel = gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft'], { json: true });
  const names = rel.assets.map((a) => a.name);
  const one = (re, what) => {
    const hits = names.filter((n) => re.test(n) && n.includes(version));
    if (hits.length > 1) die(`more than one ${what} on ${tag}: ${hits.join(', ')}`);
    return hits[0];
  };
  // The Windows installer: the one .exe whose name carries the version, or else the one .exe of the
  // release (cue-win-x64.exe; write() then checks its ProductVersion).
  const exes = names.filter((n) => /\.exe$/i.test(n));
  const exe = one(/\.exe$/i, 'Windows installer') || (exes.length === 1 ? exes[0] : undefined);
  if (!exe && exes.length > 1) die(`more than one Windows installer on ${tag}: ${exes.join(', ')}`);
  // Every mac zip of this version (cue: x64 and arm64), one zip per architecture.
  const zips = names.filter((n) => /-mac-.*\.zip$/i.test(n) && n.includes(version)).sort(macOrder);
  const arch = (n) => (/arm64/.test(n) ? 'arm64' : /universal/.test(n) ? 'universal' : 'x64');
  if (new Set(zips.map(arch)).size !== zips.length) die(`more than one mac zip per architecture on ${tag}: ${zips.join(', ')}`);
  const dmg = one(/-mac-.*\.dmg$/i, 'mac dmg');
  const jobs = [];
  if (exe && (opts.force || !names.includes('latest.yml'))) jobs.push({ feed: 'latest.yml', files: [exe] });
  if (zips.length && (opts.force || !names.includes('latest-mac.yml'))) jobs.push({ feed: 'latest-mac.yml', files: [...zips, dmg].filter(Boolean) });
  if (!exe) console.log(`publik-update-feed: ${tag} has no Windows installer yet: no latest.yml`);
  if (!zips.length) console.log(`publik-update-feed: ${tag} has no mac zip yet: no latest-mac.yml (upload the zips, then run this again)`);
  if (!jobs.length) { console.log(`publik-update-feed: nothing to do for ${tag}`); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publik-feed-'));
  const bin = path.join(dir, 'assets');
  const out = path.join(dir, 'feed');
  const wanted = [...new Set(jobs.flatMap((j) => j.files))];
  gh(['release', 'download', tag, '--repo', repo, '--dir', bin, ...wanted.flatMap((n) => ['--pattern', n])]);
  const w = { app, version, out, 'download-base': `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/` };
  for (const j of jobs) {
    if (j.feed === 'latest.yml') w.win = path.join(bin, j.files[0]);
    else {
      w['mac-zip'] = j.files.filter((n) => /\.zip$/i.test(n)).map((n) => path.join(bin, n));
      w['mac-dmg'] = j.files.filter((n) => /\.dmg$/i.test(n)).map((n) => path.join(bin, n));
    }
  }
  const feeds = write(w);
  sign(feeds, opts);
  const upload = feeds.flatMap((f) => [f, `${f}.sig`]);
  gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...upload]); // --clobber touches only the feed files
  console.log(`publik-update-feed: uploaded ${upload.map((f) => path.basename(f)).join(', ')} to ${tag}${rel.isDraft ? ' (draft)' : ''}`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === 'write') write(opts);
  else if (cmd === 'sign') sign(opts._, opts);
  else if (cmd === 'verify') verify(opts._, opts);
  else if (cmd === 'release') release(opts);
  else die('usage: publik-update-feed.cjs write|sign|verify|release ... (see the top of this file)');
}

module.exports = { feedText, fileEntry, write, exeProductVersions, parseArgs };
