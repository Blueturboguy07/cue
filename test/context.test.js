const test = require('node:test');
const assert = require('node:assert');
const { buildContext, getRecent, buildSystem, buildUserTurn, windowFor } = require('../src/context');
const { MODES } = require('../src/prompts');

const turns = [
  { channel: 'them', text: 'hello', ts: 1 },
  { channel: 'you', text: 'hi', ts: 2 },
  { channel: 'them', text: 'question?', ts: 3 }
];

test('buildContext assembles a normalized context', () => {
  const ctx = buildContext({ transcript: turns, userText: 'ok', settings: { context: 'I work at Acme' } });
  assert.strictEqual(ctx.profile, 'I work at Acme');
  assert.strictEqual(ctx.userText, 'ok');
  assert.strictEqual(ctx.recent.length, 3);
});

test('getRecent returns newest N turns oldest-first', () => {
  const recent = getRecent(turns, 2);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].text, 'hi');
  assert.strictEqual(recent[1].text, 'question?');
});

test('buildSystem weaves profile into assist/say/ask but not leetcode', () => {
  const ctx = { profile: 'ZZ_PROFILE_SENTINEL_ZZ' };
  for (const key of ['assist', 'say', 'ask']) {
    const def = { ...MODES[key], key };
    const sys = buildSystem(def, ctx);
    assert.ok(sys.includes('ZZ_PROFILE_SENTINEL_ZZ'), key + ' should inject profile');
  }
  const leet = buildSystem({ ...MODES.leetcode, key: 'leetcode' }, ctx);
  assert.ok(!leet.includes('ZZ_PROFILE_SENTINEL_ZZ'));
});

test('buildUserTurn passes only the rolling window, not the full transcript', () => {
  const ctx = buildContext({ transcript: turns });
  const turn = buildUserTurn(MODES.assist, ctx);
  assert.ok(typeof turn === 'string');
  assert.ok(turn.includes('Them:'));
});

test('windowFor returns sensible sizes per mode', () => {
  assert.strictEqual(windowFor('assist'), 12);
  assert.strictEqual(windowFor('recap'), 0);
  assert.strictEqual(windowFor('unknown'), 12);
});