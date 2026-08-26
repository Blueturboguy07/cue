const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildDisplayMediaRequest } = require('../src/display-media');

// Electron's Streams.audio accepts only 'loopback', 'loopbackWithMute', or a
// WebFrameMain. Passing the boolean `true` makes getDisplayMedia reject with
// "AbortError: Error starting capture" before the request ever reaches the OS,
// which surfaces to the user as a screen-recording permission error on a
// machine whose permissions are already granted. Loopback capture is also
// Windows-only, so every other platform has to omit the field rather than ask
// Electron for a source it cannot supply.
const VALID_AUDIO_VALUES = ['loopback', 'loopbackWithMute'];

const screenSource = { id: 'screen:0:0', name: 'Entire screen' };

test('requests Windows system audio as a loopback source', () => {
  const request = buildDisplayMediaRequest({ sources: [screenSource], platform: 'win32' });

  assert.equal(request.audio, 'loopback');
  assert.ok(VALID_AUDIO_VALUES.includes(request.audio));
});

test('never asks for audio as a boolean, which Electron aborts on', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const request = buildDisplayMediaRequest({ sources: [screenSource], platform });

    assert.notEqual(request.audio, true, `${platform} still requests audio as a boolean`);
  }
});

test('omits audio on platforms where Electron has no loopback capture', () => {
  for (const platform of ['darwin', 'linux']) {
    const request = buildDisplayMediaRequest({ sources: [screenSource], platform });

    assert.equal('audio' in request, false, `${platform} must not request loopback audio`);
  }
});

test('captures the first screen source as video on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const request = buildDisplayMediaRequest({ sources: [screenSource, { id: 'screen:1:0' }], platform });

    assert.equal(request.video, screenSource);
  }
});

test('returns null when no screen source is available to capture', () => {
  assert.equal(buildDisplayMediaRequest({ sources: [], platform: 'win32' }), null);
  assert.equal(buildDisplayMediaRequest({ sources: undefined, platform: 'win32' }), null);
});

// main.js needs Electron to load, so it cannot be exercised here. Scan it
// instead so the inline boolean cannot creep back in beside the shared helper.
test('main.js builds its display-media response through the shared helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.ok(source.includes('buildDisplayMediaRequest'), 'main.js does not use the shared helper');
  assert.ok(!/request\.audio\s*=\s*true/.test(source), 'main.js still assigns a boolean to request.audio');
});
