// CI only (.github/workflows/live-update-proof.yml). Not part of the app.
//
// The live update proof: a REAL release of cue, downloaded the way a user downloads it, installed the way a
// user installs it, started the normal way, updated by the LIVE feed https://publikhq.com/api/updates/cue/.
// No test build, no test hook, no feed override: the installed release build asks publik's feed itself.
//
//   node live-update-proof.cjs mac --from-tag v0.2.16 --expect 0.2.17 --arch arm64 --out proof
//   node live-update-proof.cjs win --from-tag v0.2.16 --expect 0.2.17 --out proof
//
// --expect equal to the version of --from-tag: the harness check. The app must say "no update" and stay.
// --expect higher: the app must find, download and stage the update by itself; the proof then does what a
// user does to finish (quit, open again) and checks the new version.
//
// What the app may do here: cue updates FIRST at app ready, before the sign-in gate (test/updater-wiring.test.js
// checks the order). The proof never signs in and never clicks into cue. Every microphone, camera and
// screen-capture call of cue comes after the gate, so cue never reaches them. Two environment variables keep
// the start-up honest on a shared runner and do NOT touch the update path:
//   DO_NOT_TRACK=1                    no usage counting (a runner is not a user)
//   PUBLIK_ORIGIN=http://127.0.0.1:9  the sign-in gate's account API: a closed port. The gate then shows
//                                     "publik is not reachable" and stays, and the runner is never registered
//                                     as a publik install. The update feed URL is built into the app
//                                     (publik-updater.cjs FEED_BASE) and does not read this variable.
// One Chromium switch, --log-net-log=<file>, records the URLs the app requests (the feed on publikhq.com, the
// installer on GitHub). It changes nothing the app does.
//
// macOS: the restart question and the result of "Check for Updates…" appear in cue's main window, which
// exists only after the sign-in. Before the sign-in there is no question to answer: the proof records that,
// waits until Squirrel.Mac has staged the update while the app keeps running (the "Later" answer), then
// closes the gate window as a user does; the update installs at quit. The unit tests cover the question and
// the menu item (test/updater-schedule.test.js).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const REPO = process.env.GITHUB_REPOSITORY || 'Blueturboguy07/cue';
const BUNDLE_ID = 'com.cue.overlay';
const TEAM_ID = 'R5R3ZS54LV';
const KEY_ID = 'F5E0515C77912BD0';
const FEED_BASE = 'https://publikhq.com/api/updates/cue/';
const FEED = isMac ? 'latest-mac.yml' : 'latest.yml';
const APP_ENV = { DO_NOT_TRACK: '1', PUBLIK_ORIGIN: 'http://127.0.0.1:9' };
const APP_ENV_REMOVE = ['PUBLIK_UPDATES', 'PUBLIK_UPDATE_URL', 'PUBLIK_UPDATER_TEST', 'PUBLIK_UPDATER_RESULT', 'ELECTRON_RUN_AS_NODE', 'PUBLIK_SELF_TEST', 'PUBLIK_API_KEY'];
const MAC_APP = '/Applications/cue.app';
const GATE_TITLE = 'Sign in with publik';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ output

let OUT = null;
let TRANSCRIPT = null;
const checks = [];
const facts = {};

function note(text) {
  const s = String(text);
  console.log(s);
  if (TRANSCRIPT) fs.appendFileSync(TRANSCRIPT, `${s}\n`);
}

function check(name, pass, detail) {
  const d = detail == null ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  checks.push({ name, pass: !!pass, detail: d });
  note(`${pass ? 'PASS' : 'FAIL'}  ${name}${d ? ` — ${d}` : ''}`);
  return !!pass;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', input: opts.input, env: opts.env || process.env, cwd: opts.cwd,
    timeout: opts.timeout || 180_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (!opts.quiet) {
    const shown = opts.hideArgs ? `${cmd} …` : [cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    note(`$ ${shown}${r.error ? ` (${r.error.code || r.error.message})` : ''} [exit ${r.status}]${out ? `\n${out.slice(0, opts.max || 3000)}` : ''}`);
  }
  return { status: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function hashFile(file, alg, enc) {
  return crypto.createHash(alg).update(fs.readFileSync(file)).digest(enc);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; } else o._.push(argv[i]);
  }
  return o;
}

// ------------------------------------------------------------------ release and feed

function ghJson(args) {
  const r = run('gh', args, { quiet: true });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.out.slice(0, 500)}`);
  return JSON.parse(r.stdout);
}

function curlText(url) {
  const r = run(isWin ? 'curl.exe' : 'curl', ['-fsSL', '--retry', '3', url], { quiet: true });
  return r.status === 0 ? r.stdout : null;
}

/** version / files[{url, sha512, size}] of an electron-updater feed (the subset the feed script writes). */
function parseFeed(text) {
  if (!text) return null;
  const version = (text.match(/^version: '?([^'\n]+)'?$/m) || [])[1] || null;
  const app = (text.match(/^publikApp: '?([^'\n]+)'?$/m) || [])[1] || null;
  const files = [];
  const re = /^ {2}- url: '?([^'\n]+)'?\n {4}sha512: '?([^'\n]+)'?\n {4}size: (\d+)/gm;
  let m;
  while ((m = re.exec(text))) files.push({ url: m[1], sha512: m[2], size: Number(m[3]) });
  return { version, app, files };
}

/** Downloads the release asset the way a browser does: the public URL, no token. */
function downloadAsset(tag, name, dir) {
  const rel = ghJson(['api', `repos/${REPO}/releases/tags/${tag}`]);
  check(`release ${tag} is public (not a draft, not a prerelease)`, !rel.draft && !rel.prerelease, `${rel.html_url}`);
  const asset = (rel.assets || []).find((a) => a.name === name);
  const expectedUrl = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
  if (!check(`release ${tag} has the asset ${name}`, asset && asset.browser_download_url === expectedUrl, asset ? asset.browser_download_url : (rel.assets || []).map((a) => a.name).join(', '))) {
    throw new Error(`no ${name} on ${tag}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const r = run(isWin ? 'curl.exe' : 'curl', ['-fsSL', '--retry', '3', '-o', file, expectedUrl], { timeout: 900_000 });
  if (!check(`clean download of ${expectedUrl}`, r.status === 0 && fs.existsSync(file), `${fs.existsSync(file) ? fs.statSync(file).size : 0} bytes`)) throw new Error('download failed');
  const sha256 = hashFile(file, 'sha256', 'hex');
  const sha512 = hashFile(file, 'sha512', 'base64');
  const sums = curlText(`https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt`);
  if (sums) {
    const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}`) || l.trim().endsWith(` *${name}`));
    check(`${name}: sha256 = the release's SHA256SUMS.txt`, line && line.startsWith(sha256), `${sha256}`);
  } else note(`note: ${tag} has no SHA256SUMS.txt`);
  const relFeed = parseFeed(curlText(`https://github.com/${REPO}/releases/download/${tag}/${FEED}`));
  const entry = relFeed && relFeed.files.find((f) => f.url === expectedUrl);
  check(`${name}: sha512 = the entry in ${tag}'s signed ${FEED}`, entry && entry.sha512 === sha512 && entry.size === fs.statSync(file).size, entry ? `${sha512.slice(0, 24)}…` : 'no entry');
  facts.downloadedByHarness = [expectedUrl];
  return { file, url: expectedUrl, sha256 };
}

/** What publik serves right now (recorded, not asserted: the proof must also work the day before a release). */
function liveFeed() {
  const text = curlText(`${FEED_BASE}${FEED}`);
  const sig = curlText(`${FEED_BASE}${FEED}.sig`);
  const f = parseFeed(text);
  facts.liveFeed = f ? { feed: FEED, version: f.version, publikApp: f.app, urls: f.files.map((x) => x.url), sigBytes: sig ? sig.length : 0 } : { feed: FEED, status: 'not served' };
  note(`publik serves ${FEED}: ${JSON.stringify(facts.liveFeed)}`);
  return f;
}

// ------------------------------------------------------------------ the app's log

const RX = {
  sig: /\[updates\] (latest(?:-mac)?\.yml) (\S+): signature OK \(key ([0-9A-F]{16})\)/g,
  notAvailable: /Update for version (\S+) is not available \(latest version: (\S+?),/g,
  found: /Found version (\S+) \(url: ([^)\n]*)\)/g,
  downloading: /Downloading update from (\S[^\n]*)/g,
  downloaded: /New version (\S+) has been downloaded to ([^\n]+)/g,
  error: /\[updates\][^\n]*\b(?:Error|error|ERR_[A-Z_]+)\b[^\n]*/g,
};

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** The app's output of one start: stdout and (macOS) stderr. */
const launchLog = (l) => `${readLog(l.log)}\n${l.err ? readLog(l.err) : ''}`;

function scanLog(text) {
  const all = (re) => [...text.matchAll(re)];
  return {
    sig: all(RX.sig).map((m) => ({ feed: m[1], version: m[2], keyId: m[3] })),
    notAvailable: all(RX.notAvailable).map((m) => ({ current: m[1], latest: m[2] })),
    found: all(RX.found).map((m) => ({ version: m[1], urls: m[2] })),
    downloading: all(RX.downloading).map((m) => m[1]),
    downloaded: all(RX.downloaded).map((m) => ({ version: m[1], file: m[2].trim() })),
    errors: all(RX.error).map((m) => m[0]),
  };
}

/** URLs the app requested, from Chromium's net log (written in full when the app quits). */
function netlogUrls(file) {
  const text = readLog(file);
  const urls = new Set();
  for (const m of text.matchAll(/"url":"(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls];
}

async function waitForOutcome(launch, { wantUpdate, staged, timeoutMs = 480_000 }) {
  const t0 = Date.now();
  let s = scanLog('');
  while (Date.now() - t0 < timeoutMs) {
    s = scanLog(launchLog(launch));
    if (s.errors.length) break;
    if (!wantUpdate && s.notAvailable.length) break;
    if (wantUpdate && s.downloaded.length && (!staged || staged())) break;
    if (wantUpdate && s.notAvailable.length) break; // the app found no update: the checks below say so
    await sleep(2000);
  }
  s.seconds = Math.round((Date.now() - t0) / 1000);
  note(`updater outcome after ${s.seconds} s: ${JSON.stringify(s)}`);
  return s;
}

// ------------------------------------------------------------------ macOS

const FIRST_OPEN_DIALOG_AS = `tell application "System Events"
  if not (exists process "CoreServicesUIAgent") then return "no dialog"
  tell process "CoreServicesUIAgent"
    if (count of windows) is 0 then return "no dialog"
    set t to ""
    try
      set AppleScript's text item delimiters to " / "
      set t to (value of static texts of window 1) as text
    end try
    if exists button "Open" of window 1 then
      click button "Open" of window 1
      return "clicked Open | " & t
    end if
    return "dialog without an Open button | " & t
  end tell
end tell`;

function macPlist(app, key) {
  const r = run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { quiet: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function macIdentity(app) {
  const dv = run('codesign', ['-dvv', app], { quiet: true }).out;
  const dr = run('codesign', ['-d', '-r-', app], { quiet: true }).out;
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { quiet: true });
  const gk = run('spctl', ['-a', '-vvv', '-t', 'exec', app], { quiet: true });
  const staple = run('xcrun', ['stapler', 'validate', app], { quiet: true });
  return {
    version: macPlist(app, 'CFBundleShortVersionString'),
    bundleId: macPlist(app, 'CFBundleIdentifier'),
    authority: [...dv.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]),
    teamId: (dv.match(/^TeamIdentifier=(.*)$/m) || [])[1] || null,
    runtime: /flags=0x\w+\(runtime\)|Runtime Version=/.test(dv),
    dr: (dr.match(/designated => (.*)/) || [])[1] || null,
    codesign: verify.status === 0 ? 'valid' : verify.out.slice(0, 400),
    spctl: gk.out,
    spctlAccepted: gk.status === 0 && /accepted/.test(gk.out),
    spctlSource: (gk.out.match(/source=(.*)/) || [])[1] || null,
    stapled: staple.status === 0 && /worked/.test(staple.out),
    quarantine: run('xattr', ['-p', 'com.apple.quarantine', app], { quiet: true }).stdout.trim() || null,
  };
}

/** The main cue process (not its helpers, not ShipIt): [{ pid, command }]. */
function macMainProcesses() {
  const out = run('ps', ['-axo', 'pid=,command='], { quiet: true }).stdout;
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(' ');
    return { pid: Number(l.slice(0, i)), command: l.slice(i + 1) };
  }).filter((p) => /\/cue\.app\/Contents\/MacOS\/cue( |$)/.test(p.command));
}

function macAllProcesses() {
  const out = run('ps', ['-axo', 'pid=,command='], { quiet: true }).stdout;
  return out.split('\n').map((l) => l.trim()).filter((l) => /\/cue\.app\/Contents\//.test(l) && !/ShipIt/.test(l) && !/live-update-proof/.test(l));
}

function macWindows() {
  const as = `tell application "System Events"
  set ps to (every process whose bundle identifier is "${BUNDLE_ID}")
  if (count of ps) is 0 then return "(no cue process)"
  set out to ""
  repeat with w in (windows of (item 1 of ps))
    set out to out & (name of w as text) & linefeed
  end repeat
  return out
end tell`;
  const r = run('osascript', ['-e', as], { quiet: true, timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [`(System Events: ${r.out.slice(0, 200)})`];
}

function macScreenshot(name) {
  const f = path.join(OUT, `${name}.png`);
  run('screencapture', ['-x', f], { quiet: true, timeout: 30_000 });
  if (fs.existsSync(f)) note(`screenshot: ${path.basename(f)}`);
}

function macPending() {
  const d = path.join(os.homedir(), 'Library', 'Caches', 'cue-updater', 'pending');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

/** The update Squirrel.Mac has staged for ShipIt (installed when the app quits): { dir, version } or null. */
function macStaged() {
  const base = path.join(os.homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`);
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const app = path.join(base, d, 'cue.app');
    if (d.startsWith('update.') && fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) {
      return { dir: path.join(base, d), version: macPlist(app, 'CFBundleShortVersionString'), state: fs.existsSync(path.join(base, 'ShipItState.plist')) };
    }
  }
  return null;
}

async function macLaunch(label) {
  const log = path.join(OUT, `app-${label}.log`);
  const err = path.join(OUT, `app-${label}.stderr.log`);
  const netlog = path.join(OUT, `netlog-${label}.json`);
  fs.writeFileSync(log, '');
  fs.writeFileSync(err, '');
  for (const [k, v] of Object.entries(APP_ENV)) run('launchctl', ['setenv', k, v], { quiet: true });
  for (const k of APP_ENV_REMOVE) run('launchctl', ['unsetenv', k], { quiet: true });
  const help = run('open', ['--help'], { quiet: true }).out; // prints the usage (an unknown option); -h would search headers
  const args = ['-a', MAC_APP];
  if (/--stdout/.test(help)) args.push('--stdout', log, '--stderr', err);
  if (/--env/.test(help)) for (const [k, v] of Object.entries(APP_ENV)) args.push('--env', `${k}=${v}`);
  args.push('--args', `--log-net-log=${netlog}`);
  note(`--- launch ${label}: open ${args.join(' ')}`);
  const child = spawn('open', args, { stdio: 'ignore', detached: true });
  child.unref();
  let dialog = 'no dialog';
  let main = [];
  for (let i = 0; i < 45 && !main.length; i++) {
    await sleep(2000);
    main = macMainProcesses();
    if (!main.length) {
      const d = run('osascript', ['-e', FIRST_OPEN_DIALOG_AS], { quiet: true, timeout: 30_000 });
      if (d.stdout.trim() && d.stdout.trim() !== 'no dialog') { dialog = d.stdout.trim(); note(`first-open dialog: ${dialog}`); macScreenshot(`${label}-first-open-dialog`); }
    }
  }
  const p = main[0] || null;
  note(`main process: ${p ? `${p.pid} ${p.command}` : 'none'}`);
  return { label, log, err, netlog, pid: p && p.pid, command: p && p.command, dialog, translocated: !!(p && /AppTranslocation/.test(p.command)) };
}

/** Quits cue as a user does at the sign-in gate: closes its window (the gate quits the app). */
async function macQuit(launch) {
  const as = `tell application "System Events"
  set ps to (every process whose bundle identifier is "${BUNDLE_ID}")
  if (count of ps) is 0 then return "no process"
  set w to window 1 of (item 1 of ps)
  set n to name of w
  click (first button of w whose subrole is "AXCloseButton")
  return "closed the window " & n
end tell`;
  const r = run('osascript', ['-e', as], { timeout: 30_000 });
  let how = r.status === 0 ? r.stdout.trim() : null;
  for (let i = 0; i < 20 && macMainProcesses().length; i++) await sleep(1000);
  if (macMainProcesses().length && launch.pid) {
    // Fallback: SIGTERM, which Electron handles as a normal quit (before-quit, will-quit, quit), like Cmd-Q.
    note('the window close did not quit cue: sending SIGTERM (Electron quits normally on it)');
    try { process.kill(launch.pid, 'SIGTERM'); } catch {}
    how = `${how || r.out.slice(0, 120)}; then SIGTERM`;
    for (let i = 0; i < 20 && macMainProcesses().length; i++) await sleep(1000);
  }
  let left = macAllProcesses();
  for (let i = 0; i < 15 && left.length; i++) { await sleep(1000); left = macAllProcesses(); }
  return { how, left };
}

function sqlite(db, sql, { quiet = true } = {}) {
  return run('sudo', ['sqlite3', '-separator', '|', db], { input: sql, quiet });
}

const TCC_USER = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
const TCC_SYSTEM = '/Library/Application Support/com.apple.TCC/TCC.db';
// Each grant in the database where macOS keeps it: camera and microphone per user, screen recording and
// accessibility in the system database.
const GRANTS = [
  { service: 'kTCCServiceMicrophone', db: TCC_USER, reason: 2 },
  { service: 'kTCCServiceCamera', db: TCC_USER, reason: 2 },
  { service: 'kTCCServiceScreenCapture', db: TCC_SYSTEM, reason: 3 },
  { service: 'kTCCServiceAccessibility', db: TCC_SYSTEM, reason: 3 },
];

function tccColumns(db) {
  const r = sqlite(db, 'PRAGMA table_info(access);');
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [cid, name, type, notnull, dflt] = l.split('|');
    return { cid: Number(cid), name, type, notnull: notnull === '1', dflt: dflt === '' ? null : dflt };
  });
}

function tccWrite(drText) {
  const req = path.join(OUT, 'designated-requirement.bin');
  const c = run('csreq', ['-r-', '-b', req], { input: drText });
  if (!check('the csreq blob of the designated requirement is made (csreq -r- -b)', c.status === 0 && fs.existsSync(req), `${fs.existsSync(req) ? fs.statSync(req).size : 0} bytes`)) return false;
  const hex = fs.readFileSync(req).toString('hex');
  check('sanity: the installed app satisfies that requirement before any update', run('codesign', ['--verify', '-R', req, MAC_APP]).status === 0);
  for (const db of [TCC_USER, TCC_SYSTEM]) note(`--- ${db} schema\n${sqlite(db, '.schema access').out}`);
  const now = Math.floor(Date.now() / 1000);
  for (const g of GRANTS) {
    const cols = tccColumns(g.db);
    const values = {
      service: `'${g.service}'`, client: `'${BUNDLE_ID}'`, client_type: '0', auth_value: '2', auth_reason: String(g.reason),
      auth_version: '1', csreq: `X'${hex}'`, policy_id: 'NULL', indirect_object_identifier_type: 'NULL',
      indirect_object_identifier: "'UNUSED'", indirect_object_code_identity: 'NULL', flags: '0', last_modified: String(now),
      allowed: '1', prompt_count: '1', // the schema before macOS 11
    };
    const use = cols.filter((col) => col.name in values);
    const missing = cols.filter((col) => col.notnull && col.dflt == null && !(col.name in values));
    const sql = `INSERT OR REPLACE INTO access (${use.map((col) => col.name).join(', ')}) VALUES (${use.map((col) => values[col.name]).join(', ')});`;
    const r = sqlite(g.db, sql, { quiet: false });
    check(`TCC grant written: ${g.service} for ${BUNDLE_ID} (${g.db === TCC_USER ? 'user' : 'system'} TCC.db)`, r.status === 0 && !missing.length, missing.length ? `columns without a value: ${missing.map((m) => m.name).join(', ')}` : r.out.slice(0, 200));
  }
  return true;
}

function tccRows() {
  const rows = [];
  for (const g of GRANTS) {
    const r = sqlite(g.db, `SELECT service, client, client_type, auth_value, auth_reason, hex(csreq), last_modified FROM access WHERE client='${BUNDLE_ID}' AND service='${g.service}';`);
    const [service, client, clientType, authValue, authReason, csreqHex, lastModified] = r.stdout.trim().split('|');
    rows.push({ service: service || g.service, db: g.db === TCC_USER ? 'user' : 'system', present: !!service, client, clientType, authValue, authReason, csreqHex: csreqHex || '', lastModified });
  }
  return rows;
}

/** For each stored grant: decode its csreq and check that the app on disk satisfies it (what tccd checks). */
function tccVerify(rows, label) {
  for (const row of rows) {
    if (!check(`${label}: TCC row ${row.service} (${row.db}) is still there, allowed (auth_value 2)`, row.present && row.authValue === '2', row)) continue;
    const blob = path.join(OUT, `csreq-${label}-${row.service}.bin`);
    fs.writeFileSync(blob, Buffer.from(row.csreqHex, 'hex'));
    const text = run('csreq', ['-r', blob, '-t']).stdout.trim();
    const byText = run('codesign', ['--verify', `-R=${text}`, MAC_APP]);
    const byBlob = run('codesign', ['--verify', '-R', blob, MAC_APP]);
    check(`${label}: the updated app satisfies the stored csreq of ${row.service}`, text && byText.status === 0 && byBlob.status === 0, text);
  }
}

/** TCC log lines about cue: no request for the microphone, camera, screen or system audio (a preflight is only a status read). */
function tccLog(startText) {
  const r = run('log', ['show', '--start', startText, '--info', '--style', 'compact', '--predicate', 'subsystem == "com.apple.TCC"'], { quiet: true, timeout: 300_000 });
  const lines = r.stdout.split('\n');
  fs.writeFileSync(path.join(OUT, 'tcc.log'), r.stdout);
  const FORBIDDEN = ['kTCCServiceMicrophone', 'kTCCServiceCamera', 'kTCCServiceScreenCapture', 'kTCCServiceAudioCapture'];
  const about = (l) => l.includes(BUNDLE_ID) || l.includes('/cue.app/');
  const msgId = (l) => (l.match(/msgID=([0-9.]+)/) || [])[1];
  const ids = new Set(lines.filter(about).map(msgId).filter(Boolean));
  const reqs = new Map();
  for (const l of lines) {
    const id = msgId(l);
    if (!id || !ids.has(id)) continue;
    const c = reqs.get(id) || {};
    const ctx = l.match(/AUTHREQ_CTX: .*service=(kTCCService\w+), preflight=(\w+)/);
    if (ctx) { c.service = ctx[1]; c.preflight = ctx[2]; }
    const send = l.match(/(\S+)\[\d+:[0-9a-f]+\] \[com\.apple\.TCC[^\]]*\] SEND: .*service=(kTCCService\w+)/);
    if (send) { c.sender = send[1]; c.service = c.service || send[2]; }
    reqs.set(id, c);
  }
  const list = [...reqs.values()].filter((c) => c.service);
  const bad = list.filter((c) => FORBIDDEN.includes(c.service) && c.preflight !== 'yes');
  const summary = list.map((c) => `${c.service} preflight=${c.preflight || '?'} sender=${c.sender || '?'}`);
  note(`TCC checks that involve cue: ${summary.length ? summary.join('; ') : 'none'}`);
  check('cue made no microphone, camera, screen or system-audio request (TCC log; a preflight status read is allowed)', !bad.length, bad.length ? bad : `${list.length} TCC check(s) involve cue`);
}

async function mac(o) {
  const arch = o.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64');
  const from = o.from;
  const wantUpdate = o.expect !== from;
  note(`=== cue live update proof, macOS ${arch}: ${o['from-tag']} -> expect ${o.expect} (${wantUpdate ? 'update' : 'harness check: no update'})`);
  run('sw_vers', []);
  run('uname', ['-m']);
  run('csrutil', ['status']);
  run('sudo', ['spctl', '--master-enable']);
  check('Gatekeeper is on (spctl --status)', /assessments enabled/.test(run('spctl', ['--status']).out));
  check(`this runner is ${arch}`, run('uname', ['-m'], { quiet: true }).stdout.trim() === (arch === 'x64' ? 'x86_64' : 'arm64'));
  check('no cue is installed or running before the proof', !fs.existsSync(MAC_APP) && !macAllProcesses().length);
  liveFeed();

  // 1. Download (quarantine flag on, as a browser sets it), Gatekeeper, install.
  const work = path.join(OUT, 'work');
  const dl = downloadAsset(o['from-tag'], `cue-${from}-mac-${arch}.zip`, path.join(work, 'download'));
  const q = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;${crypto.randomUUID().toUpperCase()}`;
  run('xattr', ['-w', 'com.apple.quarantine', q, dl.file]);
  const x = path.join(work, 'unzipped');
  fs.mkdirSync(x, { recursive: true });
  check('the zip unpacks (ditto -x -k, as Archive Utility)', run('ditto', ['-x', '-k', dl.file, x]).status === 0 && fs.existsSync(path.join(x, 'cue.app')));
  run('xattr', ['-rw', 'com.apple.quarantine', q, path.join(x, 'cue.app')], { quiet: true }); // a browser download keeps the flag on every file
  const dlId = macIdentity(path.join(x, 'cue.app'));
  note(`downloaded app: ${JSON.stringify(dlId, null, 1)}`);
  check('the downloaded app carries the quarantine flag', !!dlId.quarantine, dlId.quarantine);
  check('Gatekeeper accepts the downloaded app: Notarized Developer ID (spctl -a -t exec, quarantine set)', dlId.spctlAccepted && dlId.spctlSource === 'Notarized Developer ID' && dlId.spctl.includes(TEAM_ID), dlId.spctl.replace(/\n/g, ' | '));
  check('the notarization ticket is stapled (stapler validate)', dlId.stapled);
  check('codesign --verify --deep --strict', dlId.codesign === 'valid', dlId.codesign);
  check(`the downloaded app is ${from}`, dlId.version === from, dlId.version);
  // Install as a user does: Finder moves the app to /Applications. ditto is the fallback.
  const finder = run('osascript', ['-e', `tell application "Finder" to move (POSIX file "${path.join(x, 'cue.app')}" as alias) to (POSIX file "/Applications" as alias) with replacing`], { timeout: 60_000 });
  let method = 'Finder move';
  if (finder.status !== 0 || !fs.existsSync(path.join(MAC_APP, 'Contents', 'Info.plist'))) {
    method = `ditto (Finder refused: ${finder.out.slice(0, 160) || finder.error && finder.error.code})`;
    run('ditto', [path.join(x, 'cue.app'), MAC_APP]);
  }
  facts.installMethod = method;
  check(`installed to ${MAC_APP} (${method})`, fs.existsSync(path.join(MAC_APP, 'Contents', 'Info.plist')));
  fs.rmSync(work, { recursive: true, force: true });
  // App Translocation: macOS runs a quarantined app that the USER has not moved with Finder from a random
  // read-only folder, where no update can install. A user's own Finder drag turns that off; a scripted
  // Finder move does not (run 44509070799: both Macs ran cue translocated). Gatekeeper has accepted the
  // quarantined copy above, so the proof now removes the flag from the installed copy, which has the same
  // effect as the user's drag, and then checks that cue runs from /Applications.
  run('xattr', ['-dr', 'com.apple.quarantine', MAC_APP]);

  // 2. The designated requirement, and real TCC grants for it.
  const before = macIdentity(MAC_APP);
  facts.identityBefore = before;
  note(`installed app: ${JSON.stringify(before, null, 1)}`);
  check('the installed app: bundle ID com.cue.overlay, Developer ID of team R5R3ZS54LV, hardened runtime', before.bundleId === BUNDLE_ID && before.teamId === TEAM_ID && before.authority[0] === `Developer ID Application: Mann Bellani (${TEAM_ID})` && before.runtime, before.authority.join(' > '));
  check('designated requirement recorded (codesign -d -r-)', !!before.dr, before.dr);
  tccWrite(before.dr);
  const rowsBefore = tccRows();
  note(`TCC rows before: ${JSON.stringify(rowsBefore.map((r) => ({ service: r.service, db: r.db, auth_value: r.authValue, csreq: `${r.csreqHex.slice(0, 16)}… (${r.csreqHex.length / 2} bytes)` })))}`);
  check('all four TCC rows are in place before the start', rowsBefore.every((r) => r.present && r.authValue === '2'));
  run('xattr', ['-l', MAC_APP]);

  // 3. Start the installed app the normal way.
  const tccStart = run('date', ['+%Y-%m-%d %H:%M:%S'], { quiet: true }).stdout.trim();
  macScreenshot('0-before-start');
  const l1 = await macLaunch('1');
  check('cue runs from /Applications, not from an App Translocation copy', !l1.translocated, l1.command);
  check('cue started (the normal way: open -a /Applications/cue.app)', !!l1.pid, `${l1.command || 'no process'}; first-open dialog: ${l1.dialog}`);
  check('the running cue is the installed copy in /Applications', l1.command && l1.command.startsWith(`${MAC_APP}/Contents/MacOS/cue`), l1.command);
  await sleep(5000);
  facts.windowsAtStart = macWindows();
  macScreenshot('1-started');
  check(`cue waits at the sign-in gate (its only window: "${GATE_TITLE}")`, facts.windowsAtStart.length >= 1 && facts.windowsAtStart.every((w) => w === GATE_TITLE), facts.windowsAtStart.join(' | '));

  // 4. The updater, on its own.
  const s1 = await waitForOutcome(l1, { wantUpdate, staged: () => { const st = macStaged(); return st && st.version === o.expect; } });
  facts.firstStart = s1;
  const sigOk = s1.sig.find((x2) => x2.feed === FEED);
  check(`the app verified the signature of publik's ${FEED} (key ${KEY_ID})`, sigOk && sigOk.keyId === KEY_ID && sigOk.version === o.expect, sigOk);
  check('no updater error in the log', !s1.errors.length, s1.errors.join(' | '));
  if (!wantUpdate) {
    check(`the app says "no update": current ${from}, latest ${o.expect}`, s1.notAvailable.some((n) => n.current === from && n.latest === o.expect), s1.notAvailable);
    check('the app downloaded nothing', !s1.found.length && !s1.downloading.length && !s1.downloaded.length && !macPending().some((f) => /\.zip$/.test(f)) && !macStaged(), { found: s1.found, pending: macPending() });
  } else {
    check(`the app found ${o.expect} in the feed`, s1.found.some((f) => f.version === o.expect), s1.found);
    const want = `https://github.com/${REPO}/releases/download/v${o.expect}/cue-${o.expect}-mac-${arch}.zip`;
    check(`the app downloaded the ${arch} zip of v${o.expect} from GitHub (the URL in the signed feed)`, s1.downloading.some((u) => u.includes(want)) && s1.downloaded.some((d) => d.version === o.expect && d.file.endsWith(`cue-${o.expect}-mac-${arch}.zip`)), { downloading: s1.downloading, downloaded: s1.downloaded });
    const st = macStaged();
    facts.staged = st;
    check(`Squirrel.Mac accepted the code signature and staged ${o.expect} for ShipIt`, st && st.version === o.expect && st.state, st);
    // "Later": the app keeps running on the old version until it quits. No restart by itself.
    note('the restart question appears in cue\'s main window, which exists only after the sign-in: there is no question to answer at the gate (the "Later" path: install at quit)');
    facts.windowsAfterDownload = macWindows();
    macScreenshot('2-update-staged');
    await sleep(30_000);
    const still = macMainProcesses();
    check('"Later": 30 s after staging, the same cue process still runs and the disk still holds the old version', still.some((p) => p.pid === l1.pid) && macPlist(MAC_APP, 'CFBundleShortVersionString') === from, { pids: still.map((p) => p.pid), disk: macPlist(MAC_APP, 'CFBundleShortVersionString') });
  }

  // 5. Quit as a user does (close the gate window), then open again.
  const q1 = await macQuit(l1);
  check('cue quits when its window is closed; no cue process is left', !q1.left.length, `${q1.how}; left: ${q1.left.join(' | ') || 'none'}`);
  const urls1 = netlogUrls(l1.netlog);
  facts.netlog1 = urls1.filter((u) => /publikhq\.com|github\.com|githubusercontent\.com/.test(u));
  note(`requests in the net log: ${JSON.stringify(facts.netlog1)}`);
  check(`the app asked publikhq.com for ${FEED} and ${FEED}.sig (net log)`, urls1.some((u) => u.startsWith(`${FEED_BASE}${FEED}?`) || u === `${FEED_BASE}${FEED}`) && urls1.some((u) => u.startsWith(`${FEED_BASE}${FEED}.sig`)), facts.netlog1);
  if (wantUpdate) {
    check('the app itself requested the GitHub asset of the update (net log)', urls1.some((u) => u.includes(`/releases/download/v${o.expect}/cue-${o.expect}-mac-${arch}.zip`)), facts.netlog1);
    let v = null;
    for (let i = 0; i < 150; i++) { v = macPlist(MAC_APP, 'CFBundleShortVersionString'); if (v === o.expect) break; await sleep(2000); }
    check(`ShipIt installed ${o.expect} into ${MAC_APP} after the quit`, v === o.expect, v);
    await sleep(10_000);
    check('cue did not start again by itself after the install', !macMainProcesses().length, macMainProcesses());
    for (const f of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      const p = path.join(os.homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, f));
    }
  }
  check(`the app on disk is ${o.expect} (Info.plist)`, macPlist(MAC_APP, 'CFBundleShortVersionString') === o.expect, macPlist(MAC_APP, 'CFBundleShortVersionString'));

  const l2 = await macLaunch('2');
  check('cue starts again (open -a)', !!l2.pid && l2.command.startsWith(`${MAC_APP}/Contents/MacOS/cue`), l2.command);
  const s2 = await waitForOutcome(l2, { wantUpdate: false, timeoutMs: 300_000 });
  facts.secondStart = s2;
  check(`the running app is ${o.expect}: its updater says "Update for version ${o.expect} is not available"`, s2.notAvailable.some((n) => n.current === o.expect), s2.notAvailable);
  check('second start: feed signature verified again, no error', s2.sig.some((x2) => x2.feed === FEED && x2.keyId === KEY_ID) && !s2.errors.length, { sig: s2.sig, errors: s2.errors });
  facts.windowsSecondStart = macWindows();
  macScreenshot('3-started-again');
  const q2 = await macQuit(l2);
  check('cue quits again; no cue process is left', !q2.left.length, `${q2.how}; left: ${q2.left.join(' | ') || 'none'}`);
  check('the harness never downloaded an installer of the expected version (only the app\'s updater did)', facts.downloadedByHarness.every((u) => !wantUpdate || !u.includes(`/v${o.expect}/`)), facts.downloadedByHarness);

  // 6. Signature, Gatekeeper and the TCC grants after the update.
  const after = macIdentity(MAC_APP);
  facts.identityAfter = after;
  note(`app after: ${JSON.stringify(after, null, 1)}`);
  check('designated requirement unchanged', after.dr && after.dr === before.dr, after.dr);
  check('Gatekeeper still accepts the app: Notarized Developer ID', after.spctlAccepted && after.spctlSource === 'Notarized Developer ID', after.spctl.replace(/\n/g, ' | '));
  check('codesign --verify --deep --strict after the update', after.codesign === 'valid', after.codesign);
  check('same bundle ID and signing authority after the update', after.bundleId === before.bundleId && JSON.stringify(after.authority) === JSON.stringify(before.authority), after.authority.join(' > '));
  const rowsAfter = tccRows();
  tccVerify(rowsAfter, 'after');
  check('the stored csreq of each grant is the one written before the start', rowsAfter.every((r, i) => r.csreqHex === rowsBefore[i].csreqHex));
  note('A GitHub runner cannot show a consent prompt. tccd allows a granted service when the app satisfies the stored csreq, so the checks above are the proof that the updated app needs no new prompt.');
  tccLog(tccStart);
}

// ------------------------------------------------------------------ Windows

const WIN_EXE = () => path.join(process.env.LOCALAPPDATA, 'Programs', 'cue', 'cue.exe');

function ps(command) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { quiet: true }).stdout.trim();
}

function winVersions() {
  const exe = WIN_EXE();
  // electron-builder writes the version resource with four parts (0.2.16.0); the app version is the first three.
  const product = fs.existsSync(exe) ? ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`).replace(/^(\d+\.\d+\.\d+)\.0$/, '$1') : null;
  const display = ps("Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'cue *' } | ForEach-Object { $_.DisplayVersion }");
  return { exe: product, uninstallEntry: display };
}

function winProcesses() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name = 'cue.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)|$($_.CommandLine)\" }");
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, exe, cmd] = l.split('|'); return { pid: Number(pid), ppid: Number(ppid), exe, cmd }; });
}

function winInstallerRunning() {
  return /cue-win-x64|Au_\.exe|Un_A\.exe/i.test(ps('Get-Process | ForEach-Object { $_.ProcessName + ".exe" }'));
}

function winPending() {
  const d = path.join(process.env.LOCALAPPDATA, 'cue-updater', 'pending');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

function winScreenshot(name) {
  const f = path.join(OUT, `${name}.png`);
  ps(`try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${f}') } catch { }`);
  if (fs.existsSync(f)) note(`screenshot: ${path.basename(f)}`);
}

function winWindows() {
  return ps("Get-Process cue -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }").split(/\r?\n/).filter(Boolean);
}

function winLaunch(label) {
  const log = path.join(OUT, `app-${label}.log`);
  const netlog = path.join(OUT, `netlog-${label}.json`);
  const fd = fs.openSync(log, 'w');
  const env = { ...process.env, ...APP_ENV };
  for (const k of APP_ENV_REMOVE) delete env[k];
  note(`--- launch ${label}: ${WIN_EXE()} --log-net-log=${netlog}`);
  const child = spawn(WIN_EXE(), [`--log-net-log=${netlog}`], { detached: true, stdio: ['ignore', fd, fd], env, windowsHide: false });
  child.unref();
  fs.closeSync(fd);
  return { label, log, netlog, pid: child.pid };
}

/** Quits cue as a user does at the sign-in gate: closes its window (taskkill without /F sends WM_CLOSE). */
async function winQuit(launch) {
  const r = run('taskkill', ['/PID', String(launch.pid)]);
  let how = `taskkill /PID ${launch.pid} (WM_CLOSE): ${r.out.slice(0, 120)}`;
  for (let i = 0; i < 30 && winProcesses().length; i++) await sleep(1000);
  if (winProcesses().some((p) => p.pid === launch.pid)) {
    // The same message through .NET: Process.CloseMainWindow() posts WM_CLOSE to the main window.
    how += `; CloseMainWindow: ${ps(`(Get-Process -Id ${launch.pid}).CloseMainWindow()`)}`;
    for (let i = 0; i < 30 && winProcesses().length; i++) await sleep(1000);
  }
  return { how, left: winProcesses() };
}

async function win(o) {
  const from = o.from;
  const wantUpdate = o.expect !== from;
  note(`=== cue live update proof, Windows x64: ${o['from-tag']} -> expect ${o.expect} (${wantUpdate ? 'update' : 'harness check: no update'})`);
  run('cmd', ['/c', 'ver']);
  check('no cue is installed or running before the proof', !fs.existsSync(WIN_EXE()) && !winProcesses().length);
  liveFeed();

  // 1. Download and install with the installer's silent switch (a per-user install: no elevation).
  const work = path.join(OUT, 'work');
  const dl = downloadAsset(o['from-tag'], 'cue-win-x64.exe', path.join(work, 'download'));
  // No Mark of the Web: the installer is not Authenticode-signed, so SmartScreen would stop a script here;
  // a user clicks "Run anyway" once. The installer itself is the release asset, byte for byte (checked above).
  const inst = run(dl.file, ['/S'], { timeout: 600_000 });
  check('the installer runs silently (/S) and exits 0', inst.status === 0, `exit ${inst.status}`);
  for (let i = 0; i < 10 && winProcesses().length; i++) await sleep(1000);
  check('the installer did not start cue', !winProcesses().length, winProcesses());
  const v0 = winVersions();
  check(`installed: ${WIN_EXE()} is ${from} (exe ProductVersion and the uninstall entry)`, v0.exe === from && v0.uninstallEntry === from, v0);
  fs.rmSync(work, { recursive: true, force: true });

  // 2. Start it the normal way.
  winScreenshot('0-before-start');
  const l1 = winLaunch('1');
  await sleep(8000);
  const p1 = winProcesses();
  check('cue started (the installed cue.exe)', p1.some((p) => p.pid === l1.pid && p.exe && p.exe.toLowerCase() === WIN_EXE().toLowerCase()), p1);
  facts.windowsAtStart = winWindows();
  winScreenshot('1-started');
  check(`cue waits at the sign-in gate (window "${GATE_TITLE}")`, facts.windowsAtStart.includes(GATE_TITLE), facts.windowsAtStart);

  // 3. The updater, on its own.
  const pendingInstaller = () => winPending().some((f) => /\.exe$/i.test(f));
  const s1 = await waitForOutcome(l1, { wantUpdate, staged: pendingInstaller });
  facts.firstStart = s1;
  facts.pending = winPending();
  const sigOk = s1.sig.find((x) => x.feed === FEED);
  check(`the app verified the signature of publik's ${FEED} (key ${KEY_ID})`, sigOk && sigOk.keyId === KEY_ID && sigOk.version === o.expect, sigOk);
  check('no updater error in the log', !s1.errors.length, s1.errors.join(' | '));
  if (!wantUpdate) {
    check(`the app says "no update": current ${from}, latest ${o.expect}`, s1.notAvailable.some((n) => n.current === from && n.latest === o.expect), s1.notAvailable);
    check('the app downloaded nothing', !s1.found.length && !s1.downloading.length && !s1.downloaded.length && !pendingInstaller(), { found: s1.found, pending: winPending() });
  } else {
    check(`the app found ${o.expect} in the feed`, s1.found.some((f) => f.version === o.expect), s1.found);
    check(`the app downloaded cue-win-x64.exe of v${o.expect} from GitHub into its pending folder`, s1.downloading.some((u) => u.includes(`/releases/download/v${o.expect}/cue-win-x64.exe`)) && s1.downloaded.some((d) => d.version === o.expect) && pendingInstaller(), { downloaded: s1.downloaded, pending: winPending() });
    note('the restart question appears in cue\'s main window, which exists only after the sign-in: there is no question to answer at the gate (the "Later" path: install at quit)');
    winScreenshot('2-update-downloaded');
    await sleep(30_000);
    const v = winVersions();
    check('"Later": 30 s after the download, the same cue process still runs and the installed version is still the old one', winProcesses().some((p) => p.pid === l1.pid) && v.exe === from, { pids: winProcesses().map((p) => p.pid), v });
  }

  // 4. Quit as a user does (close the window), then open again.
  const q1 = await winQuit(l1);
  check('cue quits when its window is closed; no cue process is left', !q1.left.length, `${q1.how}; left: ${JSON.stringify(q1.left)}`);
  await sleep(3000);
  const urls1 = netlogUrls(l1.netlog);
  facts.netlog1 = urls1.filter((u) => /publikhq\.com|github\.com|githubusercontent\.com/.test(u));
  note(`requests in the net log: ${JSON.stringify(facts.netlog1)}`);
  check(`the app asked publikhq.com for ${FEED} and ${FEED}.sig (net log)`, urls1.some((u) => u.startsWith(`${FEED_BASE}${FEED}?`) || u === `${FEED_BASE}${FEED}`) && urls1.some((u) => u.startsWith(`${FEED_BASE}${FEED}.sig`)), facts.netlog1);
  if (wantUpdate) {
    check('the app itself requested the GitHub asset of the update (net log)', urls1.some((u) => u.includes(`/releases/download/v${o.expect}/cue-win-x64.exe`)), facts.netlog1);
    let v = null;
    for (let i = 0; i < 150; i++) { v = winVersions(); if (v.exe === o.expect && v.uninstallEntry === o.expect && !winInstallerRunning()) break; await sleep(2000); }
    check(`the installer of ${o.expect} ran at the quit (silent) and installed it`, v.exe === o.expect && v.uninstallEntry === o.expect, v);
    await sleep(10_000);
    check('cue did not start again by itself after the install', !winProcesses().length, winProcesses());
  }
  const v1 = winVersions();
  check(`the app on disk is ${o.expect} (exe ProductVersion and the uninstall entry)`, v1.exe === o.expect && v1.uninstallEntry === o.expect, v1);

  const l2 = winLaunch('2');
  await sleep(8000);
  check('cue starts again', winProcesses().some((p) => p.pid === l2.pid), winProcesses());
  const s2 = await waitForOutcome(l2, { wantUpdate: false, timeoutMs: 300_000 });
  facts.secondStart = s2;
  check(`the running app is ${o.expect}: its updater says "Update for version ${o.expect} is not available"`, s2.notAvailable.some((n) => n.current === o.expect), s2.notAvailable);
  check('second start: feed signature verified again, no error', s2.sig.some((x) => x.feed === FEED && x.keyId === KEY_ID) && !s2.errors.length, { sig: s2.sig, errors: s2.errors });
  winScreenshot('3-started-again');
  const q2 = await winQuit(l2);
  check('cue quits again; no cue process is left', !q2.left.length, `${q2.how}; left: ${JSON.stringify(q2.left)}`);
  check('the harness never downloaded an installer of the expected version (only the app\'s updater did)', facts.downloadedByHarness.every((u) => !wantUpdate || !u.includes(`/v${o.expect}/`)), facts.downloadedByHarness);

  // The Windows privacy store: cue never used the microphone or the camera.
  const hits = ps("foreach ($cap in 'microphone','webcam') { $root = \"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\$cap\\NonPackaged\"; if (Test-Path $root) { Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '(?i)cue\\.exe|Programs#cue#' } | ForEach-Object { \"${cap}: $($_.PSChildName)\" } } }");
  check('cue never used the microphone or the camera (Windows privacy store)', !hits, hits || 'none recorded');
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (!['mac', 'win'].includes(cmd) || !o['from-tag'] || !o.expect || !o.out) {
    console.error('usage: live-update-proof.cjs mac|win --from-tag vX.Y.Z --expect X.Y.Z [--arch arm64|x64] --out <dir>');
    process.exit(2);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(o['from-tag']) || !/^\d+\.\d+\.\d+$/.test(o.expect)) throw new Error('from-tag must look like v1.2.3 and expect like 1.2.3');
  o.from = o['from-tag'].slice(1);
  OUT = path.resolve(o.out);
  fs.mkdirSync(OUT, { recursive: true });
  TRANSCRIPT = path.join(OUT, 'transcript.log');
  fs.writeFileSync(TRANSCRIPT, '');
  const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  if (cmp(o.expect, o.from) < 0) throw new Error('expect_version must not be lower than the version of from_tag');
  try {
    if (cmd === 'mac') {
      if (!isMac) throw new Error('mac runs on macOS');
      await mac(o);
    } else {
      if (!isWin) throw new Error('win runs on Windows');
      await win(o);
    }
  } catch (e) {
    check(`the proof ran to the end without an exception`, false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    // Never leave cue running on the runner.
    if (isMac) for (const p of macMainProcesses()) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
    if (isWin) for (const p of winProcesses()) run('taskkill', ['/PID', String(p.pid), '/T', '/F'], { quiet: true });
  }
  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const result = { platform: process.platform, arch: o.arch || process.arch, fromTag: o['from-tag'], expect: o.expect, pass, checks, facts };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  note(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed: ${pass ? 'PASS' : 'FAIL'}`);
  for (const c of checks.filter((x) => !x.pass)) note(`FAILED: ${c.name} — ${c.detail}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
