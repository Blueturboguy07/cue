const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ipcMain = new EventEmitter();
const originalLoad = Module._load;
let focus = 0, dialogs = 0;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    app: { focus: () => { focus++; }, getVersion: () => '0.0.0-test', getPath: () => require('node:os').tmpdir() }, ipcMain,
    dialog: { showMessageBox: async () => { dialogs++; return { response: 1 }; } },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { requestConsent, startAppLink } = require('../src/applink');
Module._load = originalLoad;

test('a hidden or paused app denies consent without showing an external fallback', async () => {
  const allowed = await requestConsent({ callerName: 'Synthetic', scope: 'read' }, { canPrompt: () => false, getWindow: () => null });
  assert.equal(allowed, false);
  assert.equal(focus, 0);
  assert.equal(dialogs, 0);
});

test('pause invalidates an open consent prompt and removes all response handlers', async () => {
  const window = new EventEmitter(), request = new AbortController(), messages = [];
  window.isDestroyed = () => false;
  window.isVisible = () => true;
  window.focus = () => {};
  window.webContents = { send: (channel, data) => messages.push({ channel, data }) };
  const pending = requestConsent({ callerName: 'Synthetic', scope: 'read' }, {
    canPrompt: () => true, getWindow: () => window, privacySignal: () => request.signal,
  });
  const id = messages.find((m) => m.channel === 'applink:consent-request').data.id;
  request.abort();
  assert.equal(await pending, false);
  ipcMain.emit('applink:consent-response', { sender: window.webContents }, { id, allowed: true });
  assert.equal(ipcMain.listenerCount('applink:consent-response'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  assert.ok(messages.some((m) => m.channel === 'applink:consent-cancelled' && m.data.id === id));
});

test('authorized actions and pending slide consent cannot cross a pause boundary', async () => {
  const { AppLinkServer } = require('../vendor/app-link');
  const action = AppLinkServer.prototype.action, start = AppLinkServer.prototype.start;
  const actions = new Map();
  AppLinkServer.prototype.action = function (name, definition) { actions.set(name, definition); };
  AppLinkServer.prototype.start = async () => {};
  let epoch = new AbortController(), decision = 'granted', captures = 0, slideReads = 0, saved = 0;
  try {
    startAppLink({
      snapshot: () => ({}), privacySignal: () => epoch.signal,
      setCapturing: async () => { captures++; return true; },
      getSlides: () => { slideReads++; return []; }, getSlidesConsent: () => decision,
      setSlidesConsent: () => { saved++; }, getWindow: () => null,
    });
    const caller = { id: 'synthetic', name: 'Synthetic' };
    epoch.abort();
    await assert.rejects(actions.get('set_capturing').handler({ active: true }, { caller }), /privacy-paused/);
    await assert.rejects(actions.get('get_slides').handler({}, { caller }), /privacy-paused/);
    epoch = new AbortController(); decision = undefined;
    const pending = actions.get('get_slides').handler({}, { caller });
    epoch.abort();
    await assert.rejects(pending, /privacy-paused/);
    assert.equal(captures, 0);
    assert.equal(slideReads, 0);
    assert.equal(saved, 0);
  } finally {
    AppLinkServer.prototype.action = action;
    AppLinkServer.prototype.start = start;
  }
});
