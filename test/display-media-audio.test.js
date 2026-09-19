const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

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
