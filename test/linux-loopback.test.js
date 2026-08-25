const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { ensureLoopbackSource, unloadLoopbackSource, SOURCE_NAME } = require('../src/linux-loopback');

function pactlOk() {
  try { execFileSync('pactl', ['info'], { timeout: 5000, stdio: 'ignore' }); return true; }
  catch { return false; }
}

const hasPactl = pactlOk();

test('ensureLoopbackSource creates the CueSystemAudio source', { skip: !hasPactl && 'no pactl/PulseAudio on this machine' }, async () => {
  unloadLoopbackSource(); // start clean: no stale module from a previous run
  const result = await ensureLoopbackSource();
  assert.equal(result.ok, true);
  assert.ok(result.sink.length > 0);
  const sources = execFileSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8' });
  assert.ok(sources.includes(SOURCE_NAME), 'source should be listed after ensure');

  // Calling twice must not go silent-double-load: the stale module is replaced.
  const again = await ensureLoopbackSource();
  assert.equal(again.ok, true);
  const modules = execFileSync('pactl', ['list', 'short', 'modules'], { encoding: 'utf8' });
  assert.equal(modules.split('\n').filter((l) => l.includes(`source_name=${SOURCE_NAME}`)).length, 1,
    'exactly one cue module after repeated ensure');

  unloadLoopbackSource();
  const after = execFileSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8' });
  assert.ok(!after.includes(SOURCE_NAME), 'source removed after unload');
});
