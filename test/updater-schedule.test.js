// The updater's own behaviour in the installed app (publik-updater.cjs), against a stubbed Electron and a
// stubbed electron-updater, with a fake clock:
//   - the check at launch and the 24-hour check (scheduled, and it fires);
//   - "Check for Updates…" (cue: the button at the bottom of Settings, IPC updates:check → checkNow()):
//     its answer when there is no newer version, when no feed is published, and while a download runs;
//   - the restart question: "Restart Now" installs, "Later" does not (the update installs at quit).
// The live update proof (.github/workflows/live-update-proof.yml) cannot reach these on a runner: they show in
// cue's main window, which opens only after the sign-in.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const DAY = 24 * 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fake clock for setInterval only (the updater uses nothing else). */
function fakeClock() {
  const timers = [];
  let now = 0;
  return {
    timers,
    setInterval(fn, ms) { const t = { fn, ms, next: now + ms }; timers.push(t); return t; },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
      }
      now = end;
    },
  };
}

/**
 * Loads publik-updater.cjs with a stubbed `electron` and `electron-updater` and calls startUpdates() as cue's
 * main.js does. `feed(updater)` decides what each checkForUpdates() finds.
 */
function start({ platform = 'darwin', version = '0.2.16', feed, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-updater-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cue', version }));
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\nurl: https://publikhq.com/api/updates/cue/\n');
  const updater = new EventEmitter();
  Object.assign(updater, {
    checks: 0,
    installs: [],
    feedOptions: null,
    setFeedURL(o) { this.feedOptions = o; },
    checkForUpdates() {
      this.checks++;
      setImmediate(() => { this.emit('checking-for-update'); feed(this); });
      return Promise.resolve(null);
    },
    quitAndInstall(...a) { this.installs.push(a); },
  });
  const nativeUpdater = new EventEmitter();
  const app = { getAppPath: () => dir, getName: () => 'cue', getVersion: () => version, getPath: () => dir, isPackaged: true, exit() {} };
  const electron = { app, autoUpdater: nativeUpdater, dialog: {}, BrowserWindow: { getFocusedWindow: () => null }, Menu: {} };
  const shown = [];
  const answers = [];
  const show = (options) => { shown.push(options); return Promise.resolve({ response: answers.length ? answers.shift() : 0 }); };
  const clock = fakeClock();

  const saved = { load: Module._load, platform: Object.getOwnPropertyDescriptor(process, 'platform'), resourcesPath: process.resourcesPath, setInterval: global.setInterval, env: {} };
  for (const k of ['PUBLIK_UPDATES', 'PUBLIK_UPDATER_TEST', 'PUBLIK_UPDATE_URL', ...Object.keys(env)]) { saved.env[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater: updater, CancellationToken: class {} };
    return saved.load.call(this, request, parent, isMain);
  };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.resourcesPath = dir;
  global.setInterval = clock.setInterval;
  const restore = () => {
    Module._load = saved.load;
    Object.defineProperty(process, 'platform', saved.platform);
    process.resourcesPath = saved.resourcesPath;
    global.setInterval = saved.setInterval;
    for (const [k, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete require.cache[require.resolve('../publik-updater.cjs')];
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    delete require.cache[require.resolve('../publik-updater.cjs')];
    const { startUpdates } = require('../publik-updater.cjs');
    // As main.js: menu false (cue has no menu bar), the messages go to cue's window (show).
    const updates = startUpdates({ slug: 'cue', appName: 'cue', menu: false, show });
    return { updates, updater, nativeUpdater, shown, answers, clock, restore };
  } catch (e) {
    restore();
    throw e;
  }
}

const noUpdate = (u) => u.emit('update-not-available', { version: '0.2.16' });

test('the installed app checks at launch and every 24 hours (fake clock), silently when there is no update', async () => {
  const t = start({ feed: noUpdate });
  try {
    await flush();
    assert.equal(t.updater.checks, 1, 'one check at launch');
    assert.equal(t.updater.autoDownload, true);
    assert.equal(t.updater.autoInstallOnAppQuit, true, '"Later" installs the update when the app quits');
    assert.equal(t.updater.allowDowngrade, false);
    assert.equal(t.updater.feedOptions.url, 'https://publikhq.com/api/updates/cue/');
    assert.deepEqual(t.clock.timers.map((x) => x.ms), [DAY], 'one 24-hour timer');
    t.clock.tick(DAY - 1);
    await flush();
    assert.equal(t.updater.checks, 1, 'nothing before 24 hours');
    t.clock.tick(1);
    await flush();
    assert.equal(t.updater.checks, 2, 'the 24-hour check fired');
    t.clock.tick(DAY);
    await flush();
    assert.equal(t.updater.checks, 3, 'and again 24 hours later');
    assert.deepEqual(t.shown, [], 'a background check that finds nothing shows nothing');
  } finally {
    t.restore();
  }
});

test('the 24-hour check does not start a second check while an update is downloading or waits for a restart', async () => {
  let stage = 'download';
  const t = start({ platform: 'win32', feed: (u) => { if (stage === 'download') u.emit('update-available', { version: '0.2.17' }); } });
  try {
    await flush();
    assert.equal(t.updater.checks, 1);
    t.clock.tick(DAY);
    await flush();
    assert.equal(t.updater.checks, 1, 'skipped: a download is running');
    t.updater.emit('update-downloaded', { version: '0.2.17' });
    await flush();
    t.clock.tick(DAY);
    await flush();
    assert.equal(t.updater.checks, 1, 'skipped: the update waits for a restart');
    stage = 'none';
  } finally {
    t.restore();
  }
});

test('PUBLIK_UPDATES=0 stops the launch check and the 24-hour check', async () => {
  const t = start({ feed: noUpdate, env: { PUBLIK_UPDATES: '0' } });
  try {
    await flush();
    assert.equal(t.updater.checks, 0);
    assert.deepEqual(t.clock.timers, []);
  } finally {
    t.restore();
  }
});

for (const platform of ['darwin', 'win32']) {
  test(`"Check for Updates…" (${platform}): the answer after the update is "You’re up to date."`, async () => {
    const t = start({ platform, version: '0.2.17', feed: (u) => u.emit('update-not-available', { version: '0.2.17' }) });
    try {
      await flush();
      assert.deepEqual(t.shown, [], 'the launch check is silent');
      t.updates.checkNow(); // what ipcMain 'updates:check' calls (the Settings button)
      await flush();
      assert.equal(t.updater.checks, 2);
      assert.equal(t.shown.length, 1);
      assert.equal(t.shown[0].title, 'No update');
      assert.equal(t.shown[0].message, 'You’re up to date.');
      assert.equal(t.shown[0].detail, 'cue 0.2.17 is the newest version.');
    } finally {
      t.restore();
    }
  });
}

test('"Check for Updates…" with no feed published: "No update is available."', async () => {
  const t = start({ feed: (u) => u.emit('error', Object.assign(new Error('Cannot get latest-mac.yml from the update feed: HttpError: 404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })) });
  try {
    await flush();
    assert.deepEqual(t.shown, [], 'a background failure is silent');
    t.updates.checkNow();
    await flush();
    assert.equal(t.shown.length, 1);
    assert.equal(t.shown[0].message, 'No update is available.');
  } finally {
    t.restore();
  }
});

test('"Check for Updates…" with a refused feed says the update failed', async () => {
  const t = start({ feed: (u) => u.emit('error', Object.assign(new Error('latest-mac.yml is not signed by the publik update key: signature does not match the file'), { code: 'ERR_PUBLIK_FEED_SIGNATURE' })) });
  try {
    await flush();
    t.updates.checkNow();
    await flush();
    assert.equal(t.shown.length, 1);
    assert.equal(t.shown[0].title, 'Update failed');
    assert.match(t.shown[0].detail, /not signed by the publik update key/);
  } finally {
    t.restore();
  }
});

test('Windows: the restart question; "Later" does not install now, "Restart Now" installs and starts again', async () => {
  const t = start({ platform: 'win32', feed: (u) => u.emit('update-available', { version: '0.2.17' }) });
  try {
    t.answers.push(1); // Later
    await flush();
    t.updater.emit('update-downloaded', { version: '0.2.17' });
    await flush();
    assert.equal(t.shown.length, 1);
    assert.deepEqual(t.shown[0].buttons, ['Restart Now', 'Later']);
    assert.equal(t.shown[0].message, 'cue 0.2.17 is ready to install.');
    await flush();
    assert.deepEqual(t.updater.installs, [], '"Later": nothing installs now (autoInstallOnAppQuit installs at quit)');
    // Later, the user clicks "Check for Updates…": the same question again; this time "Restart Now".
    t.answers.push(0);
    t.updates.checkNow();
    await flush();
    await flush();
    assert.equal(t.shown.length, 2);
    assert.equal(t.shown[1].title, 'Update ready');
    assert.deepEqual(t.updater.installs, [[true, true]], 'silent install, then start the new version');
    assert.equal(t.updater.checks, 1, 'no second download');
  } finally {
    t.restore();
  }
});

test('macOS: the restart question waits until Squirrel.Mac has accepted the update', async () => {
  const t = start({ platform: 'darwin', feed: (u) => u.emit('update-available', { version: '0.2.17' }) });
  try {
    await flush();
    t.updater.emit('update-downloaded', { version: '0.2.17' });
    await flush();
    assert.deepEqual(t.shown, [], 'electron-updater has the zip, Squirrel.Mac has not checked its signature yet');
    t.answers.push(0);
    t.nativeUpdater.emit('update-downloaded');
    await flush();
    await flush();
    assert.equal(t.shown.length, 1);
    assert.equal(t.shown[0].message, 'cue 0.2.17 is ready to install.');
    assert.deepEqual(t.updater.installs, [[true, true]]);
  } finally {
    t.restore();
  }
});
