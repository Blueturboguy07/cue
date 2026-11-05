const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Electron's setDisplayMediaRequestHandler callback accepts `audio` as a
// WebFrameMain, 'loopback', or 'loopbackWithMute' — and NOTHING else. Its
// native binding throws synchronously on any other value:
//   TypeError: audio must be a WebFrameMain, "loopback" or "loopbackWithMute"
// main.js used to pass the boolean `true` on Windows, so that throw rejected
// the handler's promise chain, getDisplayMedia() surfaced it to the renderer
// as AbortError "Error starting capture", and cue told every Windows user
// "Meeting audio could not be started. Grant screen/audio access to cue and
// try again." — while the OS reported access as granted. Screen capture
// worked; call audio never did.
//
// This guards the value AND the single-invocation rule: `callback` is a
// one-time callback, so a chain that can call it twice earns Electron's
// "One-time callback was called more than once" warning.

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function displayMediaHandlerSource() {
  const start = MAIN_JS.indexOf('setDisplayMediaRequestHandler');
  assert.notEqual(start, -1, 'main.js no longer registers a setDisplayMediaRequestHandler');
  const end = MAIN_JS.indexOf('useSystemPicker', start);
  assert.notEqual(end, -1, 'could not find the end of the setDisplayMediaRequestHandler block');
  return MAIN_JS.slice(start, end);
}

test('the display-media handler never hands Electron a boolean for `audio`', () => {
  const block = displayMediaHandlerSource();
  const booleanAudio = /\baudio\s*[:=]\s*(true|false)\b/.exec(block);
  assert.equal(booleanAudio, null,
    `setDisplayMediaRequestHandler passes ${booleanAudio && booleanAudio[0]}; Electron requires ` +
    "'loopback' or 'loopbackWithMute' and throws on a boolean");
});

test('the display-media handler requests system-audio loopback', () => {
  const block = displayMediaHandlerSource();
  assert.ok(/audio\s*[:=]\s*'(loopback|loopbackWithMute)'/.test(block),
    'setDisplayMediaRequestHandler no longer asks for loopback audio, so meeting audio will not be captured');
});

test('the display-media handler invokes its one-time callback exactly once', () => {
  const block = displayMediaHandlerSource();
  const invocations = block.match(/\bcallback\s*\(/g) || [];
  assert.equal(invocations.length, 1,
    `callback( appears ${invocations.length} times in the handler; a one-time callback must be invoked from ` +
    'exactly one place or Electron reports "One-time callback was called more than once"');
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`main denies Meeting audio Off on ${platform}`, async () => {
    let handler, enumerations = 0, replies = 0, reply;
    const block = 'session.defaultSession.' + displayMediaHandlerSource() + 'useSystemPicker: false });';
    vm.runInNewContext(block, {
      isMac: platform === 'darwin', captureController: { signal: new AbortController().signal },
      store: { getSettings: () => ({ meetingAudio: false }) },
      session: { defaultSession: { setDisplayMediaRequestHandler: (fn) => { handler = fn; } } },
      desktopCapturer: { getSources: async () => { enumerations++; return [{ id: 'synthetic-screen' }]; } },
      console,
    });
    handler({}, (value) => { replies++; reply = value; });
    await new Promise(setImmediate);
    assert.equal(enumerations, 0);
    assert.equal(replies, 1);
    assert.equal(reply, undefined);
  });
}

for (const change of ['off', 'stop', 'restart']) {
  test(`a pending display grant is denied after ${change}`, async () => {
    let handler, resolve, reply, replies = 0;
    const controller = new AbortController(), captureController = { signal: controller.signal };
    const settings = { meetingAudio: true };
    const sources = new Promise((done) => { resolve = done; });
    const block = 'session.defaultSession.' + displayMediaHandlerSource() + 'useSystemPicker: false });';
    vm.runInNewContext(block, {
      captureController, store: { getSettings: () => settings },
      session: { defaultSession: { setDisplayMediaRequestHandler: (fn) => { handler = fn; } } },
      desktopCapturer: { getSources: () => sources }, console,
    });
    handler({}, (value) => { replies++; reply = value; });
    if (change === 'off') settings.meetingAudio = false;
    else controller.abort();
    if (change === 'restart') captureController.signal = new AbortController().signal;
    resolve([{ id: 'synthetic-screen' }]);
    await new Promise(setImmediate);
    assert.equal(replies, 1);
    assert.equal(reply, undefined);
  });
}
