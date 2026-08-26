const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS, formatAccelerator } = require('../src/shortcuts');

// The top bar ships a quit button with an icon, a red hover state and a
// tooltip, but nothing ever listened for its click, so the only way out of the
// app was the global shortcut. The tooltip also hardcoded the macOS glyphs,
// advertising a key combination that does not exist on Windows or Linux.
const read = (relPath) => fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');

test('renders the quit accelerator with the host platform modifier keys', () => {
  assert.equal(formatAccelerator(DEFAULTS.quit, 'darwin'), '⌘⇧X');
  assert.equal(formatAccelerator(DEFAULTS.quit, 'win32'), 'Ctrl+Shift+X');
  assert.equal(formatAccelerator(DEFAULTS.quit, 'linux'), 'Ctrl+Shift+X');
});

test('formats a single-modifier accelerator without a trailing separator', () => {
  assert.equal(formatAccelerator('Shift+Q', 'win32'), 'Shift+Q');
  assert.equal(formatAccelerator('Shift+Q', 'darwin'), '⇧Q');
});

test('returns an empty label for an accelerator that is missing or malformed', () => {
  assert.equal(formatAccelerator('', 'win32'), '');
  assert.equal(formatAccelerator(null, 'darwin'), '');
});

test('the quit button has a click handler wired to the quit channel', () => {
  const renderer = read('renderer/renderer.js');

  assert.match(renderer, /\$\('#quit-btn'\)\.addEventListener\('click'/,
    'nothing listens for a click on the quit button');
  assert.ok(renderer.includes('cue.quit()'), 'the quit button never calls through to the quit channel');
});

test('the quit tooltip is set from the platform rather than hardcoded macOS glyphs', () => {
  const markup = read('renderer/index.html');

  assert.ok(!markup.includes('Quit cue (⌘⇧X)'),
    'index.html still hardcodes the macOS quit accelerator in the tooltip');
});

test('the quit channel is registered exactly once in the main process', () => {
  const main = read('main.js');
  const registrations = main.match(/ipcMain\.on\('app:quit'/g) || [];

  assert.equal(registrations.length, 1, `app:quit is registered ${registrations.length} times`);
});
