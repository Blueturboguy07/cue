// How cue wires the self-updater (publik-updater.cjs, docs/updates.md). Source-text checks, like the
// other tests here, plus one run of startUpdates() against a stubbed Electron.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const source = require('./source-text');

const mainSrc = source.readSource('main.js');

test('the updater starts first at app ready, before the sign-in gate, the permission requests and the window', () => {
  const start = mainSrc.indexOf('app.whenReady().then(async () => {');
  assert.ok(start > -1);
  const body = mainSrc.slice(start);
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i > -1, `${needle} not found after app.whenReady()`);
    return i;
  };
  const hook = at("updates = startUpdates({ slug: 'cue', appName: 'cue', menu: false, show: showUpdateMessage });\n  if (updates.testHook) return;");
  // A test run (PUBLIK_UPDATER_TEST) returns at the hook: none of these run, so it never opens the
  // microphone, never asks for screen recording and never takes a screenshot.
  for (const later of ['ensureSignedIn(', 'requestPermissions()', 'createPermissionsWindow()', 'launchApp()']) {
    assert.ok(hook < at(later), `${later} must come after the updater test hook`);
  }
  // Nothing else in whenReady comes before the hook.
  const before = body.slice(body.indexOf('{') + 1, hook).replace(/\/\/.*$/gm, '').trim();
  assert.equal(before, '');
});

test('a test build started without PUBLIK_UPDATER_TEST exits at once and starts nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-updtest-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cue', version: '0.0.0-updtest.1', publikUpdaterTest: true }));
  const exits = [];
  const fakeApp = { getAppPath: () => dir, getName: () => 'cue', exit: (code) => exits.push(code), isPackaged: true };
  const originalLoad = Module._load;
  const originalEnv = process.env.PUBLIK_UPDATER_TEST;
  const log = console.log;
  delete process.env.PUBLIK_UPDATER_TEST;
  // Records what the updater asks Electron for: a locked test build reads `app` only (no autoUpdater,
  // no dialog, no window).
  const used = new Set();
  const electron = new Proxy({ app: fakeApp }, { get: (t, k) => { used.add(String(k)); return t[k]; } });
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  console.log = () => {};
  try {
    delete require.cache[require.resolve('../publik-updater.cjs')];
    const { startUpdates } = require('../publik-updater.cjs');
    const r = startUpdates({ slug: 'cue', appName: 'cue', menu: false });
    assert.equal(r.testHook, true);
    assert.deepEqual(exits, [0]);
    assert.deepEqual([...used], ['app']);
  } finally {
    console.log = log;
    Module._load = originalLoad;
    if (originalEnv !== undefined) process.env.PUBLIK_UPDATER_TEST = originalEnv;
    delete require.cache[require.resolve('../publik-updater.cjs')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the packaged app carries the updater and the feed URL; the repo package.json is not a test build', () => {
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const builder = require('../electron-builder.cjs');
  assert.ok(builder.files.includes('publik-updater.cjs'));
  assert.ok(builder.files.includes('publik-update-verify.cjs'));
  assert.deepEqual(builder.publish, { provider: 'generic', url: 'https://publikhq.com/api/updates/cue/' });
  const pkg = require('../package.json');
  assert.ok(pkg.dependencies['electron-updater']);
  assert.ok(pkg.dependencies.blakejs);
  assert.equal(pkg.publikUpdaterTest, undefined, 'only the CI proof sets publikUpdaterTest, in its own checkout');
});

test('update messages appear in the window: preload, click-through selector and CSS know #update-scrim', () => {
  const preload = source.readSource('preload.js');
  assert.match(preload, /updatesCheck: \(\) => ipcRenderer\.send\('updates:check'\)/);
  assert.match(preload, /updatesRespond: \(id, response\) => ipcRenderer\.send\('updates:response', \{ id, response \}\)/);
  assert.match(preload, /'updates:message'\]/);
  const renderer = source.readSource('renderer/renderer.js');
  assert.match(renderer, /el\.closest\('[^']*#update-scrim[^']*'\)/);
  assert.match(renderer, /cue\.on\('updates:message'/);
  const css = source.readSource('renderer/styles.css');
  assert.match(css, /#update-scrim \{ pointer-events: auto; \}|, #update-scrim \{ pointer-events: auto; \}/);
  const html = source.readSource('renderer/index.html');
  assert.match(html, /id="s-check-updates"[^>]*>Check for Updates…</);
  assert.match(html, /id="update-scrim"/);
  assert.match(mainSrc, /ipcMain\.on\('updates:check', \(\) => \{ if \(updates\) updates\.checkNow\(\); \}\);/);
});
