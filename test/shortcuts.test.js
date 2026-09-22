const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, resolveShortcuts, findConflicts, isValid } = require('../src/shortcuts');

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.say, 'CommandOrControl+Return');
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Shift+Return');
  assert.ok(DEFAULTS.quit);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ quit: 'CommandOrControl+L' });
  assert.strictEqual(map.quit, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ quit: 'CommandOrControl+Shift+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'quit') || (a === 'quit' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});