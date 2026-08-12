const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const os = require('os');
const {
  resolveGrokBinary,
  findExistingLeaderPid,
  getGrokCliRuntimeStatus,
  ensureLeader,
  stopGrokCliRuntime
} = require('../src/grok-cli-runtime');

test('resolveGrokBinary finds a path or falls back to grok', () => {
  const bin = resolveGrokBinary();
  assert.equal(typeof bin, 'string');
  assert.ok(bin.length > 0);
});

test('getGrokCliRuntimeStatus returns a stable shape before start', () => {
  const status = getGrokCliRuntimeStatus();
  assert.equal(typeof status.started, 'boolean');
  assert.equal(typeof status.leaderAlive, 'boolean');
  assert.equal(typeof status.lastWarmOk, 'boolean');
  assert.ok('binary' in status);
  assert.ok('leaderPid' in status);
});

test('ensureLeader starts or adopts a leader process', async () => {
  // Only run the spawn when a real grok binary is present (dev machines with Grok CLI).
  const bin = resolveGrokBinary();
  if (bin === 'grok') {
    // PATH-only — skip spawn to avoid flaking CI-like envs without Grok CLI
    return;
  }
  const fs = require('fs');
  if (!fs.existsSync(bin)) return;

  const result = ensureLeader();
  assert.equal(result.ok, true, result.reason || 'leader should start');
  assert.ok(result.pid, 'leader pid expected');

  // Give the process a moment to register, then confirm alive
  await new Promise((r) => setTimeout(r, 800));
  const pid = findExistingLeaderPid();
  assert.ok(pid, 'leader pid should be discoverable after spawn');

  // Do not kill — leaving it warm is intentional
  stopGrokCliRuntime({ killLeader: false });
  const still = findExistingLeaderPid();
  assert.ok(still, 'leader should remain alive after stopGrokCliRuntime(killLeader:false)');
});
