'use strict';
// publik-updater.cjs — signed self-updates for a publik Electron app (electron-updater, generic provider).
// Copy this file and publik-update-verify.cjs into another app unchanged; see docs/updates.md.
//
//   const { startUpdates } = require('./publik-updater.cjs');
//   app.whenReady().then(() => {
//     const updates = startUpdates({ slug: 'cue', appName: 'cue' });
//     if (updates.testHook) return; // a test build (the CI update proof): start nothing else
//     ...
//   });
//
// What it does (macOS and Windows; other platforms: nothing):
//   1. Asks https://publikhq.com/api/updates/<slug>/ for latest.yml (Windows) or latest-mac.yml (macOS)
//      and for its signature (latest.yml.sig / latest-mac.yml.sig), at launch, every 24 h and from
//      "Check for Updates…" in the menu.
//   2. Verifies the signature with the publik update public key (publik-update-verify.cjs) BEFORE
//      electron-updater reads the feed. A feed with no signature or a wrong one is refused: nothing is
//      downloaded. The feed must also name this app (`publikApp: <slug>`) and give a sha512 for every file.
//   3. electron-updater downloads the file the feed names (Windows: the NSIS installer; macOS: the zip) in
//      the background and refuses it unless its sha512 matches the signed feed. On macOS, Squirrel.Mac then
//      also requires the new app to satisfy the running app's code signature (same bundle ID, same
//      Developer ID), which keeps the camera permission.
//   4. Asks the user to restart. "Later" installs the update when the app quits. No forced restart.
//   Background failures are silent (logged only). A manual check always shows its result.
//   PUBLIK_UPDATES=0 in the environment stops the automatic checks (CI launch tests set it).
//   The messages are native dialogs, unless the app passes `show` (an app with no Dock icon shows them in
//   its own window instead: a native panel of such an app does not come forward).
//
// Test builds only (package.json "publikUpdaterTest": true, set by .github/workflows/updater-proof.yml,
// never in a release): PUBLIK_UPDATE_URL replaces the feed URL, and PUBLIK_UPDATER_TEST runs the same
// check/download/install path without a window and exits (see runTestHook below). A test build started
// WITHOUT PUBLIK_UPDATER_TEST exits at once: it never runs the app itself (no sign-in, no window, no
// microphone, no screen capture), even when something other than the proof starts it.

const fs = require('node:fs');
const path = require('node:path');
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
const { newUrlFromBase, getChannelFilename } = require('electron-updater/out/util');
const { CancellationToken } = require('electron-updater');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('./publik-update-verify.cjs');

const FEED_BASE = 'https://publikhq.com/api/updates/';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 256 * 1024;
const FEED_ERROR = 'ERR_PUBLIK_FEED_SIGNATURE';
const SHA512 = /^([A-Za-z0-9+/]{86}==|[0-9a-f]{128})$/;

function newError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * electron-updater's generic provider, with one change: getLatestVersion() reads the feed and its .sig,
 * verifies the signature, and only then parses the verified bytes. electron-updater never sees an
 * unverified feed. The file URLs in the feed may be absolute (GitHub release assets): the generic
 * provider resolves them with `new URL(url, base)`, which keeps an absolute URL as it is.
 */
class PublikSignedFeedProvider extends GenericProvider {
  constructor(options, updater, runtimeOptions) {
    super(options, updater, runtimeOptions);
    this.publicKeys = options.publicKey || PUBLIK_UPDATE_PUBLIC_KEYS;
    this.slug = options.slug;
    this.onVerified = options.onVerified || (() => {});
  }

  // electron-updater adds a random "x-user-staging-id" header to feed requests (for staged rollouts on
  // the server). publik does not use it, so the app does not send it.
  setRequestHeaders(value) {
    if (value && 'x-user-staging-id' in value) {
      const { 'x-user-staging-id': _drop, ...rest } = value;
      value = Object.keys(rest).length ? rest : null;
    }
    super.setRequestHeaders(value);
  }

  async fetchFeedFile(url, name) {
    const isSig = name.endsWith('.sig');
    let body;
    try {
      body = await this.executor.downloadToBuffer(url, { headers: this.requestHeaders || undefined, cancellationToken: new CancellationToken() });
    } catch (e) {
      const notFound = /status 404/.test(String(e && e.message));
      const code = !notFound ? e.code || 'ERR_PUBLIK_FEED_FETCH' : isSig ? FEED_ERROR : 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
      throw newError(`Cannot get ${name} from the update feed: ${e.message || e}`, code);
    }
    if (!body || body.length === 0) throw newError(`${name} is empty`, isSig ? FEED_ERROR : 'ERR_UPDATER_INVALID_UPDATE_INFO');
    if (body.length > MAX_FEED_BYTES) throw newError(`${name} is too large (${body.length} bytes)`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
    return body;
  }

  async getLatestVersion() {
    const feedName = getChannelFilename(this.channel); // latest.yml (Windows) or latest-mac.yml (macOS)
    const noCache = this.updater.isAddNoCacheQuery;
    const feedUrl = newUrlFromBase(feedName, this.baseUrl, noCache);
    const sigUrl = newUrlFromBase(`${feedName}.sig`, this.baseUrl, noCache);
    const [feed, sig] = await Promise.all([this.fetchFeedFile(feedUrl, feedName), this.fetchFeedFile(sigUrl, `${feedName}.sig`)]);
    let verified;
    try {
      verified = verifyMinisign(feed, sig, this.publicKeys, { file: feedName });
    } catch (e) {
      throw newError(`${feedName} is not signed by the publik update key: ${e.message}`, FEED_ERROR);
    }
    const info = parseUpdateInfo(feed.toString('utf8'), feedName, feedUrl);
    checkSignedFeed(info, feedName, this.slug);
    this.onVerified({ feed: feedName, version: info.version, keyId: verified.keyId, trustedComment: verified.trustedComment });
    return info;
  }
}

/** The verified feed must be for this app and must give a sha512 for every file (electron-updater would also accept sha2). */
function checkSignedFeed(info, feedName, slug) {
  if (!info || typeof info !== 'object' || typeof info.version !== 'string') {
    throw newError(`${feedName} has no version`, 'ERR_UPDATER_INVALID_UPDATE_INFO');
  }
  if (slug && info.publikApp !== slug) {
    throw newError(`${feedName} is for "${info.publikApp ?? '(no app)'}", not for "${slug}"`, FEED_ERROR);
  }
  if (!Array.isArray(info.files) || info.files.length === 0) {
    throw newError(`${feedName} lists no files`, 'ERR_UPDATER_NO_FILES_PROVIDED');
  }
  for (const f of info.files) {
    if (!f || typeof f.url !== 'string' || typeof f.sha512 !== 'string' || !SHA512.test(f.sha512)) {
      throw newError(`${feedName} has a file without a sha512`, FEED_ERROR);
    }
  }
}

/** The feed options for autoUpdater.setFeedURL(). */
function feedOptions({ slug, url, onVerified, publicKey }) {
  return { provider: 'custom', updateProvider: PublikSignedFeedProvider, url, slug, onVerified, publicKey };
}

function isTestBuild(app) {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).publikUpdaterTest === true;
  } catch {
    return false;
  }
}

/**
 * electron-builder writes resources/app-update.yml only for the dmg/zip/nsis targets. electron-updater
 * reads it for the cache folder name, and on macOS the download fails without it. A build made with
 * the "dir" target (publik-build.yml) has none, so the app writes the same small file in its own folder.
 */
function ensureUpdateConfig(app, autoUpdater, { slug, url }) {
  if (fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  const file = path.join(app.getPath('userData'), 'publik-app-update.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `provider: generic\nurl: ${JSON.stringify(url)}\nupdaterCacheDirName: ${JSON.stringify(`${slug}-updater`)}\n`);
  autoUpdater.updateConfigPath = file;
}

function makeLogger() {
  const line = (level) => (...a) => console[level]('[updates]', ...a);
  return { info: line('log'), warn: line('warn'), error: line('error') };
}

/**
 * Starts the updater. Returns { testHook, checkNow, menuItem }. `testHook` is true only in a test build:
 * the caller must then start nothing else (the hook exits the app).
 * `show(options)`: optional. Shows one message (the options of Electron's dialog.showMessageBox: type,
 * title, message, detail, buttons, defaultId, cancelId) and resolves to { response: <button index> }.
 * Without it, the messages are native dialogs.
 */
function startUpdates({ slug, appName, menu = true, show } = {}) {
  const { app } = require('electron');
  if (!slug) throw new Error('startUpdates: slug is required');
  appName = appName || app.getName();
  const off = { testHook: false, checkNow: () => {}, menuItem: () => ({ label: 'Check for Updates…', enabled: false }) };

  const testBuild = isTestBuild(app);
  if (testBuild && !process.env.PUBLIK_UPDATER_TEST) {
    console.log('[updates] this is an updater TEST build: it runs only with PUBLIK_UPDATER_TEST. Exiting.');
    app.exit(0);
    return { ...off, testHook: true };
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') return off;
  const url = (testBuild && process.env.PUBLIK_UPDATE_URL) || `${FEED_BASE}${slug}/`;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = makeLogger();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = true; // the feed lists whole files only; no .blockmap to serve
  autoUpdater.disableWebInstaller = true;
  let verified = null;
  if (app.isPackaged) {
    try { ensureUpdateConfig(app, autoUpdater, { slug, url }); } catch (e) { autoUpdater.logger.warn(`cannot write the update config: ${e.message}`); }
  }
  autoUpdater.setFeedURL(feedOptions({ slug, url, onVerified: (v) => { verified = v; autoUpdater.logger.info(`${v.feed} ${v.version}: signature OK (key ${v.keyId})`); } }));

  if (testBuild && process.env.PUBLIK_UPDATER_TEST) {
    runTestHook({ app, autoUpdater, url, getVerified: () => verified });
    return { ...off, testHook: true };
  }

  const ui = updateUI({ app, autoUpdater, appName, show });
  if (menu) setMenuWithUpdates(appName, ui.menuItem());
  if (app.isPackaged && process.env.PUBLIK_UPDATES !== '0') {
    ui.check(false);
    setInterval(() => ui.check(false), CHECK_EVERY_MS);
  }
  return { testHook: false, checkNow: () => ui.check(true), menuItem: ui.menuItem };
}

/** Dialogs and state: silent in the background, a result for every manual check, then "Restart now?". */
function updateUI({ app, autoUpdater, appName, show: present }) {
  const { dialog, BrowserWindow } = require('electron');
  let state = 'idle'; // idle | checking | downloading | downloaded
  let manual = false; // a manual check is in progress: show its result, including a download error
  let readyInfo = null;
  let promptedVersion = null;
  let promptOpen = false;

  const show = (options) => {
    if (present) return Promise.resolve(present(options));
    const parent = BrowserWindow.getFocusedWindow();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  };

  async function promptRestart(info) {
    if (promptOpen) return;
    promptOpen = true;
    promptedVersion = info.version;
    try {
      const { response } = await show({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `${appName} ${info.version} is ready to install.`,
        detail: `Restart ${appName} to finish the update. If you choose Later, the update installs when you quit ${appName}.`,
      });
      if (response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true)); // Windows: silent install, then start again
    } finally {
      promptOpen = false;
    }
  }

  autoUpdater.on('checking-for-update', () => { if (state === 'idle') state = 'checking'; });
  autoUpdater.on('update-not-available', (info) => {
    state = 'idle';
    if (!manual) return;
    manual = false;
    show({ type: 'info', buttons: ['OK'], title: 'No update', message: 'You’re up to date.', detail: `${appName} ${app.getVersion()} is the newest version.` });
  });
  autoUpdater.on('update-available', (info) => {
    state = 'downloading';
    if (manual) show({ type: 'info', buttons: ['OK'], title: 'Update available', message: `${appName} ${info.version} is available.`, detail: `It downloads in the background. ${appName} asks you to restart when it is ready.` });
  });
  // Ready = the file passed its sha512 (Windows), and on macOS Squirrel.Mac has also accepted its code
  // signature (the native autoUpdater's 'update-downloaded'); only then can "Restart Now" install it.
  const ready = (info) => {
    state = 'downloaded';
    readyInfo = info;
    const wasManual = manual;
    manual = false;
    if (wasManual || promptedVersion !== info.version) promptRestart(info);
  };
  let downloaded = null;
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info;
    if (process.platform !== 'darwin') ready(info);
  });
  if (process.platform === 'darwin') {
    require('electron').autoUpdater.on('update-downloaded', () => { if (downloaded) ready(downloaded); });
  }
  autoUpdater.on('error', (e) => {
    if (state !== 'downloaded') state = 'idle';
    if (!manual) return; // background failure: the log has it
    manual = false;
    if (e && e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') { // no feed published: no update (docs/updates.md)
      show({ type: 'info', buttons: ['OK'], title: 'No update', message: 'No update is available.', detail: `${appName} ${app.getVersion()} is the version you have.` });
      return;
    }
    show({ type: 'warning', buttons: ['OK'], title: 'Update failed', message: 'Could not update.', detail: String((e && e.message) || e).split('\n')[0].slice(0, 400) });
  });

  function check(isManual) {
    if (isManual) {
      if (state === 'downloaded' && readyInfo) return promptRestart(readyInfo);
      if (state === 'downloading') {
        return show({ type: 'info', buttons: ['OK'], title: 'Update in progress', message: 'An update is downloading.', detail: `${appName} asks you to restart when it is ready.` });
      }
      if (!app.isPackaged) {
        return show({ type: 'info', buttons: ['OK'], title: 'Updates', message: 'Updates work only in the installed app.' });
      }
      manual = true;
    } else if (state !== 'idle') {
      return; // a check or a download is already running, or an update waits for a restart
    }
    autoUpdater.checkForUpdates().catch(() => {}); // the 'error' event has it
  }

  return { check, menuItem: () => ({ label: 'Check for Updates…', click: () => check(true) }) };
}

/** Electron's default menu, plus "Check for Updates…" (macOS: in the app menu; Windows: in Help). */
function setMenuWithUpdates(appName, item) {
  const { Menu } = require('electron');
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: 'about' }, { type: 'separator' }, item, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ role: 'help', submenu: [item] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Test builds only. PUBLIK_UPDATER_TEST=report writes the running version and exits.
 * PUBLIK_UPDATER_TEST=update runs autoUpdater.checkForUpdates() — the same call the 24-hour check makes,
 * through the same signed-feed provider — then, when the update is downloaded (and on macOS accepted by
 * Squirrel.Mac), writes the result and quits to install it (Windows: silent installer; macOS: ShipIt
 * swaps the bundle once the app has quit). A refusal writes the error and exits. Nothing else starts:
 * no publik sign-in, no window. The result goes to PUBLIK_UPDATER_RESULT (JSON).
 */
function runTestHook({ app, autoUpdater, url, getVerified }) {
  const mode = process.env.PUBLIK_UPDATER_TEST;
  const out = process.env.PUBLIK_UPDATER_RESULT;
  const result = { mode, version: app.getVersion(), platform: process.platform, arch: process.arch, execPath: process.execPath, feedUrl: url, events: [] };
  let finished = false;
  const write = (extra) => {
    Object.assign(result, extra, { verifiedFeed: getVerified() });
    const text = JSON.stringify(result, null, 1);
    if (out) fs.writeFileSync(out, text); else console.log(text);
  };
  const finish = (extra, code = 0) => {
    if (finished) return;
    finished = true;
    write(extra);
    app.exit(code);
  };
  if (mode === 'report') return finish({ outcome: 'report' });
  if (mode !== 'update') return finish({ outcome: 'bad-mode' }, 2);

  autoUpdater.autoRunAppAfterInstall = false; // the proof starts the new version itself, in report mode
  const ev = (name, data) => result.events.push({ t: new Date().toISOString(), name, ...data });
  autoUpdater.on('checking-for-update', () => ev('checking-for-update'));
  autoUpdater.on('update-available', (info) => ev('update-available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => finish({ outcome: 'no-update', latest: info && info.version }));
  autoUpdater.on('error', (e) => finish({ outcome: 'error', code: e && e.code, message: String((e && e.message) || e).slice(0, 2000) }));
  autoUpdater.on('update-downloaded', (info) => {
    ev('update-downloaded', { version: info.version, file: info.downloadedFile && path.basename(info.downloadedFile) });
    const install = () => {
      if (finished) return;
      finished = true;
      write({ outcome: 'installing', newVersion: info.version });
      if (process.platform === 'win32') autoUpdater.quitAndInstall(true, false); // silent, do not start the new version
      else autoUpdater.quitAndInstall(); // Squirrel.Mac has the update: quit, ShipIt installs it
    };
    if (process.platform === 'darwin') {
      // Squirrel.Mac fetches the zip from electron-updater's local proxy and checks its code signature
      // against the running app's designated requirement. Its 'update-downloaded' means it accepted it;
      // a rejection arrives as 'error' (handled above).
      require('electron').autoUpdater.once('update-downloaded', () => { ev('squirrel-accepted'); install(); });
    } else {
      install();
    }
  });
  setTimeout(() => finish({ outcome: 'timeout' }, 3), 5 * 60 * 1000);
  autoUpdater.checkForUpdates().catch(() => {}); // the 'error' event has it
}

module.exports = { startUpdates, PublikSignedFeedProvider, checkSignedFeed, feedOptions, FEED_BASE };
