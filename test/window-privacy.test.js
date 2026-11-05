const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { protectionPolicy, createWindowPrivacy } = require('../src/window-privacy');

function windowFixture(fail) {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.webContents.send = () => {};
  window.trace = [];
  window.isDestroyed = () => false;
  window.setContentProtection = () => { window.trace.push('protect'); if (fail) throw new Error('synthetic'); };
  window.show = window.showInactive = () => window.trace.push('show');
  window.hide = () => window.trace.push('hide');
  return window;
}

for (const noProtect of ['', '0', 'false', 'no', 'off', undefined, 'invalid']) {
  test(`false-like or invalid override ${JSON.stringify(noProtect)} does not disable protection`, () => {
    assert.equal(protectionPolicy({ platform: 'darwin', noProtect }).status, 'requested');
  });
}
for (const noProtect of ['1', 'TRUE', ' Yes ', 'on']) {
  test(`explicit override ${noProtect} is reported as disabled`, () => {
    assert.deepEqual(protectionPolicy({ platform: 'darwin', noProtect }), { status: 'disabled', reason: 'debug-override' });
  });
}

test('platform policy keeps unsupported and unknown sessions distinct', () => {
  for (const [options, reason] of [
    [{ platform: 'linux' }, 'linux'],
    [{ platform: 'win32', winBuild: 19040, sessionName: 'Console' }, 'windows-build'],
    [{ platform: 'win32', winBuild: 19041 }, 'windows-session-unknown'],
    [{ platform: 'win32', winBuild: 22000, sessionName: 'RDP-Tcp#3' }, 'windows-remote-session'],
  ]) assert.equal(protectionPolicy(options).reason, reason);
  assert.equal(protectionPolicy({ platform: 'win32', winBuild: 19041, sessionName: 'Console' }).status, 'requested');
});

test('API failure is explicit and a recreated window gets its own protection state', () => {
  const privacy = createWindowPrivacy({ platform: 'darwin' });
  const failed = windowFixture(true), fresh = windowFixture();
  privacy.register(failed, 'main'); privacy.register(fresh, 'main');
  assert.equal(privacy.info(failed.webContents).protection.status, 'error');
  assert.equal(privacy.info(fresh.webContents).protection.status, 'requested');
  assert.equal(privacy.info(fresh.webContents).protection.verified, false);
});

test('reload rejects the old ready token and cannot undo a deliberate Hide', () => {
  const privacy = createWindowPrivacy({ platform: 'darwin' }), window = windowFixture();
  privacy.register(window, 'main'); privacy.setRecoverable(true);
  const old = privacy.info(window.webContents).windowToken;
  window.webContents.emit('did-start-loading');
  window.webContents.emit('did-finish-load');
  privacy.hide();
  assert.equal(privacy.ready(window.webContents, old), false);
  const token = privacy.info(window.webContents).windowToken;
  assert.equal(privacy.ready(window.webContents, token), true);
  assert.equal(window.trace.includes('show'), false);
  privacy.restore();
  assert.equal(window.trace.at(-1), 'show');
});

test('Hide needs a recovery route; restore leaves privacy pause active', () => {
  const privacy = createWindowPrivacy({ platform: 'linux' }), window = windowFixture();
  privacy.register(window, 'permissions');
  assert.equal(privacy.hide(), false);
  privacy.setRecoverable(true); privacy.setPaused(true); privacy.hide(); privacy.restore();
  assert.equal(privacy.paused, true);
  assert.equal(privacy.canPrompt(window), false);
});

test('1,000 reload/ready/hide interleavings never reveal a held window', () => {
  const privacy = createWindowPrivacy({ platform: 'darwin' }), window = windowFixture();
  privacy.register(window, 'main'); privacy.setRecoverable(true); privacy.hide();
  for (let i = 0; i < 1000; i++) {
    const old = privacy.info(window.webContents).windowToken;
    window.webContents.emit('did-start-loading');
    privacy.ready(window.webContents, old);
    privacy.ready(window.webContents, privacy.info(window.webContents).windowToken);
    window.webContents.emit('did-finish-load');
  }
  assert.equal(window.trace.includes('show'), false);
  privacy.restore();
  assert.equal(window.trace.filter((op) => op === 'show').length, 1);
});
