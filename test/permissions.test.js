const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadMain } = require('./helpers/main-harness');

test('continuing after granting permissions opens the app before closing its only window', async () => {
  const events = new Map();
  let quits = 0, launches = 0;
  const h = loadMain({ electron: {
    app: {
      commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }),
      on: (name, handler) => events.set(name, handler), quit: () => { quits++; },
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  } });
  h.context.permissionWindow = {
    close() {
      vm.runInContext('permWin = null;', h.context);
      if (!vm.runInContext('!!win', h.context)) events.get('window-all-closed')({ preventDefault() {} });
    },
  };
  h.context.openApp = () => {
    launches++;
    vm.runInContext('win = { isDestroyed: () => false };', h.context);
  };
  vm.runInContext('win = null; permWin = permissionWindow; launchApp = openApp;', h.context);

  await h.listeners.get('permissions:continue')();

  assert.equal(launches, 1);
  assert.equal(quits, 0, 'Closing the permission gate must not quit Cue after access is granted');
  assert.equal(vm.runInContext('permWin', h.context), null);
});

test('a Cue window can relaunch to apply macOS permission changes; other senders cannot', () => {
  const calls = [];
  const h = loadMain({ electron: { app: {
    commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {},
    relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit'),
  } } });
  const restart = h.listeners.get('app:relaunch');
  assert.equal(typeof restart, 'function');
  assert.throws(() => restart({ sender: {} }), /Cue window/);
  assert.deepEqual(calls, []);
  const sender = {};
  h.context.permissionWindow = { isDestroyed: () => false, webContents: sender };
  vm.runInContext('permWin = permissionWindow;', h.context);
  restart({ sender });
  assert.deepEqual(calls, ['relaunch', 'quit']);
});

function permissionPage(platform, status) {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/permissions.html'), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', disabled: false, handlers: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.handlers.set(name, fn); },
  }]));
  const calls = [];
  const cue = {
    platform, permissionsCheck: async () => { calls.push('check'); return status; },
    relaunch: () => calls.push('relaunch'), log() {},
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: (id) => elements.get(id) }, window: { cue },
  });
  return { elements, calls };
}

test('macOS permission recovery offers restart even while cached statuses remain denied', async () => {
  const h = permissionPage('darwin', { mic: 'denied', screen: 'denied' });
  await new Promise(setImmediate);
  assert.equal(h.elements.get('continue-btn').disabled, true);
  const button = h.elements.get('check-btn');
  assert.equal(button.textContent, 'Restart cue');
  await button.handlers.get('click')();
  assert.ok(h.calls.includes('relaunch'));
  assert.equal(button.disabled, true);
});

test('Windows permission recovery still rechecks permissions without restarting', async () => {
  const h = permissionPage('win32', { mic: 'denied', screen: 'granted' });
  await new Promise(setImmediate);
  await h.elements.get('check-btn').handlers.get('click')();
  assert.equal(h.calls.filter(call => call === 'check').length, 2);
  assert.equal(h.calls.includes('relaunch'), false);
});
