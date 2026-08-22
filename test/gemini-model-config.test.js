const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { CURRENT_GEMINI_DEFAULT } = require('../src/llm');

// Google retired gemini-2.0-flash on 2026-03-03 (deprecated Feb 2026); every
// request against it 404s with a generic "exception parsing response" body —
// this is the root cause behind the cluster of "Error: got status: 404"
// bug reports. Before the fix, four different files each hardcoded their own
// Gemini model id (two still pointing at the dead one), so this scans every
// source file that talks to the Gemini API and fails if a known-retired id
// or a hardcoded id that has drifted from the shared default sneaks back in.
const DEAD_MODEL_IDS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];

const FILES_THAT_CALL_GEMINI = [
  'src/llm.js',
  // store.js delegates its defaults to the durable store core, where the
  // DEFAULTS block (including the Gemini models) now lives.
  'src/settings-store-core.js',
  'src/stt.js',
  'src/stt-streaming.js'
];

test('CURRENT_GEMINI_DEFAULT is not a known-retired Gemini model id', () => {
  assert.ok(!DEAD_MODEL_IDS.includes(CURRENT_GEMINI_DEFAULT), `${CURRENT_GEMINI_DEFAULT} is on the known-dead list`);
});

for (const relPath of FILES_THAT_CALL_GEMINI) {
  test(`${relPath} does not hardcode a retired Gemini model id`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    for (const deadId of DEAD_MODEL_IDS) {
      assert.ok(!source.includes(`'${deadId}'`) && !source.includes(`"${deadId}"`),
        `${relPath} still references retired model ${deadId}`);
    }
  });
}

test('default Gemini models match the shared current default', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/settings-store-core.js'), 'utf8');
  const match = /gemini:\s*\{\s*fast:\s*'([^']+)',\s*smart:\s*'([^']+)'/.exec(source);
  assert.ok(match, 'could not find the gemini default models block in settings-store-core.js');
  assert.equal(match[1], CURRENT_GEMINI_DEFAULT);
  assert.equal(match[2], CURRENT_GEMINI_DEFAULT);
});
