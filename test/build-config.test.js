const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');

// Regression test for the actual incident behind the "cue is damaged and
// can't be opened" bug reports: package.json used to carry its own legacy
// "build" field (mac.identity: null, no publish config). electron-builder
// picked that up INSTEAD OF electron-builder.cjs, so every release —
// including the "signed and notarized" v0.2.1/v0.2.2 tags — was actually
// built unsigned and auto-published over the real asset. Fixed in
// 1a86a6c ("remove stale package.json build field so dist uses
// electron-builder.cjs"). If a "build" field ever comes back, it silently
// reintroduces the exact same failure mode.
test('package.json has no "build" field shadowing electron-builder.cjs', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'build'), false);
});

test('dist/pack scripts do not pass an inline --config that could bypass electron-builder.cjs', () => {
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/electron-builder/.test(script)) continue;
    assert.ok(!/--config/.test(script), `${name} script unexpectedly overrides config: ${script}`);
  }
});

test('mac config never auto-publishes and only claims hardened runtime / notarization with a real cert', () => {
  const original = { ...process.env };
  try {
    delete require.cache[require.resolve('../electron-builder.cjs')];
    delete process.env.MAC_SIGN;
    delete process.env.APPLE_ID;
    delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
    delete process.env.APPLE_TEAM_ID;
    const unsigned = require('../electron-builder.cjs');

    // publish:null is what stops electron-builder auto-publishing an
    // ad-hoc build over a real release asset just because GH_TOKEN is set.
    assert.equal(unsigned.publish, null);
    // No cert -> must not claim hardened runtime or notarization (would
    // otherwise fail the build outright, or worse, silently no-op).
    assert.equal(unsigned.mac.identity, null);
    assert.equal(unsigned.mac.hardenedRuntime, false);
    assert.equal(unsigned.mac.notarize, false);

    delete require.cache[require.resolve('../electron-builder.cjs')];
    process.env.MAC_SIGN = '1';
    process.env.APPLE_ID = 'dev@example.com';
    process.env.APPLE_APP_SPECIFIC_PASSWORD = 'app-specific-password';
    process.env.APPLE_TEAM_ID = 'TEAMID1234';
    const signed = require('../electron-builder.cjs');

    assert.equal(signed.publish, null);
    assert.equal(signed.mac.identity, undefined); // let electron-builder discover the keychain identity
    assert.equal(signed.mac.hardenedRuntime, true);
    assert.equal(signed.mac.notarize, true);
  } finally {
    process.env = original;
    delete require.cache[require.resolve('../electron-builder.cjs')];
  }
});

test('mac config ships the zip target with entitlements files that exist on disk', () => {
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const builder = require('../electron-builder.cjs');
  assert.deepEqual(builder.mac.target, [{ target: 'zip', arch: ['x64', 'arm64'] }]);
  const root = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, builder.mac.entitlements)));
  assert.ok(fs.existsSync(path.join(root, builder.mac.entitlementsInherit)));
  // The hardened runtime withholds mic input without this entitlement —
  // silently, with no error, which is indistinguishable from a code bug.
  const entitlementsXml = fs.readFileSync(path.join(root, builder.mac.entitlements), 'utf8');
  assert.match(entitlementsXml, /com\.apple\.security\.device\.audio-input/);
});
