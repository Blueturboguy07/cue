const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadMain, deferred } = require('./helpers/main-harness');

function windowHarness(extra = {}) {
  const windows = [];
  class Window {
    constructor(options) {
      this.options = options; this.events = new Map(); this.trace = []; windows.push(this);
      this.webContents = {
        on: (name, fn) => this.on(name, fn), send: (name, data) => this.trace.push([name, data]),
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      };
    }
    on(name, fn) { const previous = this.events.get(name); this.events.set(name, (...args) => { previous?.(...args); fn(...args); }); }
    isDestroyed() { return false; }
    setContentProtection(value) { this.trace.push(['protect', value]); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setHiddenInMissionControl() {}
    loadFile() { this.trace.push(['load']); }
    setTitle() {}
    hide() { this.trace.push(['hide']); }
    show() { this.trace.push(['show']); }
    showInactive() { this.trace.push(['show']); }
  }
  const h = loadMain({ ...extra, electron: {
    BrowserWindow: Window,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    ...extra.electron,
  } });
  vm.runInContext('win = null;', h.context);
  return { ...h, windows };
}

for (const create of ['createWindow', 'createPermissionsWindow']) {
  test(`${create} starts hidden and waits for the privacy notice before showing`, () => {
    const h = windowHarness();
    vm.runInContext(`${create}();`, h.context);
    const window = h.windows[0];
    assert.equal(window.options.show, false);
    window.events.get('did-finish-load')();
    assert.equal(window.trace.some(([name]) => name === 'show'), false);
    const snapshot = h.handlers.get('privacy:state')({ sender: window.webContents });
    h.listeners.get('window:ready')({ sender: window.webContents }, snapshot.windowToken);
    assert.equal(window.trace.filter(([name]) => name === 'show').length, 1);
    assert.ok(window.trace.findIndex(([name]) => name === 'protect') < window.trace.findIndex(([name]) => name === 'show'));
  });
}

test('privacy pause cancels an in-flight answer and blocks integration capture starts', async () => {
  const entered = deferred(); let signal;
  const h = windowHarness({ modules: {
    './src/llm': { createLLM: () => ({ ready: true, stream: (p) => { signal = p.signal; entered.resolve(); return new Promise(() => {}); } }) },
  } });
  vm.runInContext('createWindow();', h.context);
  await h.setCapturing(true);
  const pending = h.runFeature('say', '');
  await entered.promise;
  assert.equal(typeof h.handlers.get('privacy:pause'), 'function');
  await h.handlers.get('privacy:pause')({ sender: h.windows[0].webContents });
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(h.state.capturing, false);
  assert.equal(await h.setCapturing(true), false);
});

module.exports = { windowHarness };

function ownedEvent(h) {
  if (!h.windows.length) vm.runInContext('createWindow();', h.context);
  return { sender: h.windows[0].webContents };
}

test('Pause suppresses automatic notes, and Resume never restarts listening', async () => {
  const h = windowHarness(), event = ownedEvent(h); let notes = 0, cancellations = 0;
  h.context.syntheticMemory = { cancelNotes: () => { cancellations++; }, refreshNotes: async () => { notes++; } };
  vm.runInContext('meetingMemory = syntheticMemory;', h.context);
  await h.setCapturing(true);
  await h.handlers.get('privacy:pause')(event);
  assert.equal(notes, 0);
  assert.ok(cancellations > 0);
  await h.handlers.get('privacy:resume')(event);
  assert.equal(h.state.capturing, false);
  assert.equal(h.captureController.desired, false);
  assert.equal(await h.setCapturing(true), true);
  await h.handlers.get('privacy:pause')(event);
});

test('restoring a paused window leaves capture blocked', async () => {
  const shortcuts = new Map();
  const h = windowHarness({ electron: { globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; } } } });
  const event = ownedEvent(h), window = h.windows[0];
  vm.runInContext('registerRestoreShortcut();', h.context);
  window.events.get('did-finish-load')();
  const info = h.handlers.get('privacy:state')(event);
  h.listeners.get('window:ready')(event, info.windowToken);
  await h.handlers.get('privacy:pause')(event);
  assert.equal(h.handlers.get('privacy:state')(event).hidden, true);
  shortcuts.get('CommandOrControl+Shift+Space')();
  assert.equal(h.handlers.get('privacy:state')(event).hidden, false);
  assert.equal(h.handlers.get('privacy:state')(event).paused, true);
  assert.equal(await h.setCapturing(true), false);
});

test('a new Pause invalidates a queued Resume', async () => {
  const h = windowHarness(), event = ownedEvent(h);
  await h.handlers.get('privacy:pause')(event);
  const resume = h.handlers.get('privacy:resume')(event);
  await h.handlers.get('privacy:pause')(event);
  await resume;
  assert.equal(h.handlers.get('privacy:state')(event).paused, true);
});

test('Pause cancels active model downloads and denies new ones', async () => {
  const h = windowHarness(), event = ownedEvent(h); let cancelled = 0, started = 0;
  h.context.syntheticManager = { activeDownload: { modelId: 'base.en' }, cancelDownload: () => { cancelled++; }, download: () => { started++; } };
  vm.runInContext('whisperModelManager = syntheticManager;', h.context);
  await h.handlers.get('privacy:pause')(event);
  await assert.rejects(h.handlers.get('whisper:model-download')(null, 'base.en'), /Privacy pause/);
  assert.equal(cancelled, 1);
  assert.equal(started, 0);
});

test('new privacy IPC rejects wrong windows and subframes without revealing UI', async () => {
  const h = windowHarness(), event = ownedEvent(h), window = h.windows[0];
  const snapshot = h.handlers.get('privacy:state')(event);
  const hostile = { sender: window.webContents, senderFrame: {} };
  assert.throws(() => h.handlers.get('privacy:state')(hostile), /Cue window/);
  assert.doesNotThrow(() => h.listeners.get('window:ready')(hostile, snapshot.windowToken));
  assert.equal(window.trace.some(([name]) => name === 'show'), false);
  await assert.rejects(h.handlers.get('privacy:resume')({ sender: {} }), /Cue window/);
});

test('redundant Resume cannot detach an active wallet request from the pause signal', async () => {
  const result = deferred(), entered = deferred(); let signal; const writes = [];
  const publik = require('../src/publik');
  const h = windowHarness({ settings: { apiKeys: { publik: 'synthetic' }, publik: {} }, modules: {
    './src/publik': { ...publik, fetchWallet: (options) => { signal = options.signal; entered.resolve(); return result.promise; } },
  } });
  const event = ownedEvent(h);
  h.context.require('./src/store').setPublik = (patch) => writes.push(patch);
  const pending = h.handlers.get('publik:refresh')();
  await entered.promise;
  await h.handlers.get('privacy:resume')(event);
  await h.handlers.get('privacy:pause')(event);
  await h.handlers.get('privacy:resume')(event);
  result.resolve({ balanceMicros: 1, claimState: 'anonymous' });
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(writes.length, 0);
});

test('privacy pause survives reinitialization and can only be lifted explicitly', async () => {
  const h = windowHarness({ settings: { privacyPaused: true } }), event = ownedEvent(h);
  assert.equal(h.handlers.get('privacy:state')(event).paused, true);
  assert.equal(await h.setCapturing(true), false);
  await h.handlers.get('privacy:resume')(event);
  assert.equal(h.settings.privacyPaused, false);
  assert.equal(await h.setCapturing(true), true);
  await h.handlers.get('privacy:pause')(event);
  assert.equal(h.settings.privacyPaused, true);
});

test('a settings-write failure cannot prevent privacy pause from stopping work', async () => {
  const h = windowHarness(), event = ownedEvent(h);
  await h.setCapturing(true);
  h.context.require('./src/store').setSettings = () => { throw new Error('synthetic disk failure'); };
  await h.handlers.get('privacy:pause')(event);
  assert.equal(h.state.capturing, false);
  assert.equal(h.captureController.desired, false);
});
