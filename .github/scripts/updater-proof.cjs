// CI only (.github/workflows/updater-proof.yml). Not part of the app.
//
// Proves the self-updater on a real runner, against the INSTALLED test build N of the app:
//   prepare   makes the refused feeds from the good (signed) feed:
//               tampered-feed        the good feed with one byte changed, with the good .sig
//               other-key            the good feed, signed by a key made on this runner
//               no-sig               the good feed with no .sig
//               one-byte-installer   a feed signed with the REAL key whose installer URL (the file this
//                                    runner downloads: --onebyte-of) points at a copy of N+1's installer
//                                    with one byte changed (sha512 no longer matches)
//               other-identity       (macOS) a feed signed with the REAL key for N+1 re-signed with another
//                                    code-signing identity (Squirrel.Mac must refuse it)
//   run       starts N with PUBLIK_UPDATER_TEST=update for each refused feed (served from 127.0.0.1) and
//             checks that it refuses and stays on N; then for the good feed (the GitHub prerelease) and
//             checks that it downloads, installs and that the installed app then reports N+1. On macOS it
//             also compares bundle ID, designated requirement and signing authority before and after, and
//             checks that the zip of this Mac's architecture was installed.
//             cue (Blueturboguy07/cue): every start is a test-hook start, which exits before the sign-in
//             gate, the permission requests, the window, the microphone and any screen capture. The run
//             also checks that the test build refuses to start WITHOUT the hook, and that no cue process is
//             left running after any start or after the install (no relaunch).
//
//   node updater-proof.cjs prepare --good <dir> --feed latest.yml --onebyte-url <url> [--onebyte-of <file name>] [--other-identity <dir>] --out <dir>
//   node updater-proof.cjs run --app <installed executable> [--bundle <installed .app>] --old <N> --new <N+1>
//        --good-url <url/> --cases <dir> --out <result.json> --logs <dir> [--arch x64|arm64]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FEED_SCRIPT = path.join(ROOT, 'scripts', 'publik-update-feed.cjs');
const TAURI_CLI = '@tauri-apps/cli@2.12.4';
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}
const log = (...a) => console.log('[proof]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- prepare

function signWith(file, env, publicKey) {
  const r = spawnSync(process.execPath, [FEED_SCRIPT, 'sign', file, ...(publicKey ? ['--public-key', publicKey] : [])], { env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`signing ${file} failed`);
}

function prepare(o) {
  const feed = o.feed;
  const good = fs.readFileSync(path.join(o.good, feed));
  const goodSig = fs.readFileSync(path.join(o.good, `${feed}.sig`));
  const text = good.toString('utf8');
  const dir = (name) => { const d = path.join(o.out, name); fs.mkdirSync(d, { recursive: true }); return d; };

  // 1. one byte of the signed feed changed (a digit of the first file size), the good signature kept
  const tampered = Buffer.from(good);
  const at = text.indexOf('size: ') + 'size: '.length;
  tampered[at] = tampered[at] === 0x39 ? 0x38 : tampered[at] + 1;
  fs.writeFileSync(path.join(dir('tampered-feed'), feed), tampered);
  fs.writeFileSync(path.join(dir('tampered-feed'), `${feed}.sig`), goodSig);

  // 2. signed by another key: a throwaway key made here, with tauri's own generator
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otherkey-'));
  const pass = crypto.randomBytes(16).toString('hex');
  const g = spawnSync('npx', ['--yes', TAURI_CLI, 'signer', 'generate', '-w', path.join(tmp, 'other.key'), '-p', pass, '--ci'], { stdio: ['ignore', 'ignore', 'inherit'], shell: isWin, env: { ...process.env, CI: 'true' } });
  if (g.status !== 0) throw new Error('tauri signer generate failed');
  fs.writeFileSync(path.join(dir('other-key'), feed), good);
  signWith(path.join(dir('other-key'), feed), { PUBLIK_UPDATE_KEY: fs.readFileSync(path.join(tmp, 'other.key'), 'utf8'), PUBLIK_UPDATE_KEY_PASSWORD: pass }, path.join(tmp, 'other.key.pub'));

  // 3. no signature at all
  fs.writeFileSync(path.join(dir('no-sig'), feed), good);

  // 4. a validly signed feed (real key) whose installer for this runner (--onebyte-of; default: the first
  //    file) points at a copy with one byte changed; its sha512 in the feed stays the good one
  const urls = [...text.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
  const target = o['onebyte-of'] ? urls.find((u) => u.endsWith(`/${encodeURIComponent(o['onebyte-of'])}`)) : urls[0];
  if (!target) throw new Error(`${o['onebyte-of']} is not in the good feed`);
  const onebyte = text.split(target).join(o['onebyte-url']);
  fs.writeFileSync(path.join(dir('one-byte-installer'), feed), onebyte);
  signWith(path.join(dir('one-byte-installer'), feed), {}); // PUBLIK_UPDATE_KEY from the job

  // 5. macOS: N+1 re-signed with another identity, feed signed with the real key
  if (o['other-identity']) {
    fs.copyFileSync(path.join(o['other-identity'], feed), path.join(dir('other-identity'), feed));
    signWith(path.join(dir('other-identity'), feed), {});
  }
  log('cases:', fs.readdirSync(o.out).join(', '));
}

/** Flips one byte in the middle of a copy of `src`. */
function oneByte(src, dst) {
  const data = fs.readFileSync(src);
  const at = data.length >> 1;
  data[at] ^= 0xff;
  fs.writeFileSync(dst, data);
  log(`one byte flipped at offset ${at}: ${path.basename(dst)}`);
}

// ---------------------------------------------------------------- run

function serve(dir) {
  const requests = [];
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push(p);
    const f = path.resolve(root, `.${p}`);
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` })));
}

function launch(app, env, { timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(app, [], { env: { ...process.env, DO_NOT_TRACK: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      out += '\n[proof] TIMEOUT: killing the app\n';
      try { if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); if (logFile) fs.writeFileSync(logFile, out); resolve({ code, signal, out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, out: out + String(e) }); });
  });
}

async function runHook(app, mode, extraEnv, name, o) {
  const resultFile = path.join(o.logs, `${name}.result.json`);
  fs.rmSync(resultFile, { force: true });
  const r = await launch(app, { PUBLIK_UPDATER_TEST: mode, PUBLIK_UPDATER_RESULT: resultFile, ...extraEnv }, { timeoutMs: mode === 'report' ? 90_000 : 420_000, logFile: path.join(o.logs, `${name}.log`) });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  return { exit: r.code, signal: r.signal, result };
}

const plist = (bundle, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

function macIdentity(bundle) {
  const dv = spawnSync('codesign', ['-dvv', bundle], { encoding: 'utf8' }).stderr;
  const dr = spawnSync('codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  const pick = (re) => (dv.match(re) || [])[1] || null;
  const xattrs = spawnSync('xattr', [bundle], { encoding: 'utf8' }).stdout.trim();
  return {
    version: plist(bundle, 'CFBundleShortVersionString'),
    bundleId: plist(bundle, 'CFBundleIdentifier'),
    signedIdentifier: pick(/^Identifier=(.*)$/m),
    authority: [...dv.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]),
    teamIdentifier: pick(/^TeamIdentifier=(.*)$/m),
    designatedRequirement: ((dr.stdout + dr.stderr).match(/designated => (.*)/) || [])[1] || null,
    codesignVerify: verify.status === 0 ? 'valid' : `invalid: ${(verify.stderr || '').trim()}`,
    quarantine: /com\.apple\.quarantine/.test(xattrs),
  };
}

function winInstalledVersion() {
  const ps = "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'cue *' } | ForEach-Object { $_.DisplayVersion }";
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}
function winInstallerRunning() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
  return /"(cue-win-x64[^"]*|Au_\.exe|Un_A\.exe)"/i.test(r);
}

/** The cue processes running now (the app and its helpers; not ShipIt, which installs and exits). */
function appProcesses(o) {
  if (isWin) {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq cue.exe'], { encoding: 'utf8' }).stdout;
    return r.split(/\r?\n/).filter((l) => /^"cue\.exe"/i.test(l));
  }
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return r.split('\n').filter((l) => l.includes(`${o.bundle}/Contents/`) && !l.includes('ShipIt'));
}

/** The version the installed copy carries on disk (macOS: Info.plist; Windows: the uninstall entry). */
function installedVersion(o) {
  return isMac ? plist(o.bundle, 'CFBundleShortVersionString') : winInstalledVersion();
}

async function waitForInstall(o) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let v = null;
    try { v = installedVersion(o); } catch {} // ShipIt may be swapping the bundle right now
    const busy = isWin && winInstallerRunning();
    if (v === o.new && !busy) return true;
    await sleep(3000);
  }
  return false;
}

async function run(o) {
  fs.mkdirSync(o.logs, { recursive: true });
  const checks = [];
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
  const feed = isMac ? 'latest-mac.yml' : 'latest.yml';
  const summary = { platform: process.platform, arch: process.arch, old: o.old, new: o.new, goodUrl: o['good-url'], checks, cases: {} };

  // Helpers (GPU, network) can take a moment to end after the main process: wait up to 15 s.
  const noneLeft = async (when) => {
    let left = appProcesses(o);
    for (let i = 0; i < 15 && left.length; i++) { await sleep(1000); left = appProcesses(o); }
    check(`no cue process is left running ${when}`, left.length === 0, left.join(' | ') || 'none');
  };

  // A test build started without the hook must exit at once: it never runs cue itself (no sign-in, no
  // window, no microphone, no screen capture). publikhq.com is blocked on this runner (the workflow).
  const locked = await launch(o.app, {}, { timeoutMs: 60_000, logFile: path.join(o.logs, '0-locked.log') });
  check('the test build started WITHOUT PUBLIK_UPDATER_TEST exits at once (exit 0) and starts nothing',
    locked.code === 0 && /this is an updater TEST build: it runs only with PUBLIK_UPDATER_TEST/.test(locked.out), `exit ${locked.code} ${locked.signal || ''}`);
  await noneLeft('after that start');

  const before = await runHook(o.app, 'report', {}, '0-report-before', o);
  check('the installed app reports N before any update', before.result && before.result.version === o.old, before.result && before.result.version);
  if (isMac) summary.identityBefore = macIdentity(o.bundle);

  const { server, requests, origin } = await serve(o.cases);
  const refused = [
    ['tampered-feed', /not signed by the publik update key: signature does not match the file/, 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['other-key', /not signed by the publik update key: signed with key [0-9A-F]{16}, not with the update key F5E0515C77912BD0/, 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['no-sig', new RegExp(`Cannot get ${feed.replace('.', '\\.')}\\.sig`), 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['one-byte-installer', /sha512 checksum mismatch/, 'ERR_CHECKSUM_MISMATCH', true],
    ...(isMac && fs.existsSync(path.join(o.cases, 'other-identity')) ? [['other-identity', /code signature|requirement|did not pass validation/i, null, true]] : []),
  ];
  let n = 1;
  for (const [name, re, code, downloads] of refused) {
    const before = requests.length;
    const r = await runHook(o.app, 'update', { PUBLIK_UPDATE_URL: `${origin}/${name}/` }, `${n++}-${name}`, o);
    const res = r.result || {};
    const events = (res.events || []).map((e) => e.name);
    summary.cases[name] = { outcome: res.outcome, code: res.code, message: res.message, events, feedRequests: requests.slice(before), verifiedFeed: res.verifiedFeed || null };
    check(`${name}: the app refuses the update`, res.outcome === 'error' && re.test(res.message || '') && (code == null || res.code === code), `${res.outcome} ${res.code || ''} ${String(res.message || '').split('\n')[0]}`);
    check(`${name}: ${downloads ? 'it downloaded, then refused the file' : 'it refused before any download'}`, downloads ? events.includes('update-available') : !events.includes('update-available'), events.join(' > '));
    const after = await runHook(o.app, 'report', {}, `${n++}-${name}-report`, o);
    check(`${name}: the app stays on N`, after.result && after.result.version === o.old && installedVersion(o) === o.old, `${after.result && after.result.version} / on disk ${installedVersion(o)}`);
    await noneLeft(`after the ${name} case`);
  }
  server.close();

  // The good feed: the signed feed on the GitHub prerelease, absolute asset URLs.
  const good = await runHook(o.app, 'update', { PUBLIK_UPDATE_URL: o['good-url'] }, `${n++}-good`, o);
  const g = good.result || {};
  summary.cases.good = { outcome: g.outcome, newVersion: g.newVersion, events: (g.events || []).map((e) => e.name), verifiedFeed: g.verifiedFeed || null, message: g.message };
  check('good: the feed signature verifies with the publik key', g.verifiedFeed && g.verifiedFeed.keyId === 'F5E0515C77912BD0' && g.verifiedFeed.feed === feed && g.verifiedFeed.version === o.new, g.verifiedFeed);
  check('good: N finds N+1, downloads it (sha512 checked) and starts the install', g.outcome === 'installing' && g.newVersion === o.new, `${g.outcome} ${g.newVersion || g.message || ''}`);
  if (isMac) check('good: Squirrel.Mac accepted the code signature of N+1', (g.events || []).some((e) => e.name === 'squirrel-accepted'));
  if (isMac && o.arch) {
    const got = ((g.events || []).find((e) => e.name === 'update-downloaded') || {}).file || '';
    check(`good: the ${o.arch} zip was downloaded (the feed lists x64 and arm64)`, got.includes(`-mac-${o.arch}.zip`), got);
  }
  const installed = await waitForInstall(o);
  check('good: the installed copy on disk becomes N+1', installed, installedVersion(o));
  await sleep(10_000); // a relaunch after the install would show up here
  await noneLeft('after the install (the app was not started again)');
  if (isMac) {
    summary.identityAfter = macIdentity(o.bundle);
    for (const f of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      const p = path.join(os.homedir(), 'Library', 'Caches', `${summary.identityBefore.bundleId}.ShipIt`, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(o.logs, f));
    }
    if (summary.identityAfter.quarantine) log('note: the updated bundle carries com.apple.quarantine');
  }
  const after = await runHook(o.app, 'report', {}, `${n++}-report-after`, o);
  check('good: the installed app now reports N+1', after.result && after.result.version === o.new, after.result && after.result.version);
  check('good: same install location', after.result && before.result && after.result.execPath === before.result.execPath, after.result && after.result.execPath);
  if (isMac) {
    const a = summary.identityBefore;
    const b = summary.identityAfter;
    check('mac: same bundle ID after the update', a.bundleId === b.bundleId && b.bundleId === 'com.cue.overlay', b.bundleId);
    check('mac: same designated requirement (what TCC keys the camera grant on)', a.designatedRequirement && a.designatedRequirement === b.designatedRequirement, b.designatedRequirement);
    check('mac: same signing authority', JSON.stringify(a.authority) === JSON.stringify(b.authority) && a.authority.length > 0, b.authority);
    check('mac: the updated bundle passes codesign --verify --deep --strict', b.codesignVerify === 'valid', b.codesignVerify);
    if (o.arch) {
      const archs = spawnSync('lipo', ['-archs', path.join(o.bundle, 'Contents', 'MacOS', 'cue')], { encoding: 'utf8' }).stdout.trim();
      check(`mac: the updated app is the ${o.arch} build`, archs === o.arch, archs);
    }
  }

  summary.pass = checks.every((c) => c.pass);
  fs.writeFileSync(o.out, JSON.stringify(summary, null, 1));
  log(`${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  process.exit(summary.pass ? 0 : 1);
}

// ---------------------------------------------------------------- tcc (macOS)

/**
 * Reads `log show --predicate 'subsystem == "com.apple.TCC"'` output from the time of the proof and
 * lists the TCC services that the app's processes asked for. tccd logs one request on several lines
 * (AUTHREQ_CTX names the service, AUTHREQ_ATTRIBUTION names the app) with the same msgID, so the lines
 * are grouped by msgID. Fails if the app asked for the microphone, the camera or the screen.
 *   node updater-proof.cjs tcc --log tcc.log --bundle-id com.cue.overlay --out <report.txt>
 */
function tcc(o) {
  const FORBIDDEN = ['kTCCServiceMicrophone', 'kTCCServiceCamera', 'kTCCServiceScreenCapture', 'kTCCServiceAudioCapture'];
  const lines = fs.existsSync(o.log) ? fs.readFileSync(o.log, 'utf8').split('\n').filter((l) => l.trim()) : [];
  const app = (l) => l.includes(o['bundle-id']) || l.includes('/cue.app/');
  const msgId = (l) => (l.match(/msgID=([0-9.]+)/) || [])[1];
  const ids = new Set(lines.filter(app).map(msgId).filter(Boolean));
  const services = new Set();
  for (const l of lines) {
    if (!app(l) && !ids.has(msgId(l))) continue;
    for (const m of l.matchAll(/kTCCService\w+/g)) services.add(m[0]);
  }
  const bad = FORBIDDEN.filter((x) => services.has(x));
  const report = [
    `TCC log lines in the proof window: ${lines.length}`,
    `lines about ${o['bundle-id']} (or a path inside cue.app): ${lines.filter(app).length}`,
    `TCC services the app asked for: ${[...services].join(', ') || 'none'}`,
    bad.length ? `FAIL: the app asked for ${bad.join(', ')}` : `PASS: no ${FORBIDDEN.join(' / ')} request from the app`,
  ].join('\n');
  console.log(report);
  if (o.out) { fs.mkdirSync(path.dirname(o.out), { recursive: true }); fs.writeFileSync(o.out, `${report}\n\n${lines.filter((l) => app(l) || ids.has(msgId(l))).join('\n')}\n`); }
  process.exit(bad.length ? 1 : 0);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest);
if (cmd === 'prepare') prepare(o);
else if (cmd === 'one-byte') oneByte(o.src, o.dst);
else if (cmd === 'run') run(o).catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'tcc') tcc(o);
else { console.error('usage: updater-proof.cjs prepare|one-byte|run|tcc ...'); process.exit(2); }
