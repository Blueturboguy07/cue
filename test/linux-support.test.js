const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../electron-builder.cjs');
const pkg = require('../package.json');
const { getRuntimeTarget } = require('../src/whisper-runtime-manifest');

test('defines explicit Linux package and distribution targets', () => {
  assert.equal(pkg.scripts['dist:linux'], 'electron-builder --linux AppImage --x64');
  assert.equal(pkg.scripts['dist:linux:arm64'], 'electron-builder --linux AppImage --arm64');
  assert.equal(pkg.scripts['pack:linux'], 'electron-builder --linux --dir');
  assert.deepEqual(builder.linux.target, [{ target: 'AppImage', arch: ['x64', 'arm64'] }]);
});

test('defines whisper.cpp runtime targets for Linux architectures', () => {
  const x64Target = getRuntimeTarget('linux', 'x64');
  assert.equal(x64Target.kind, 'archive');
  assert.equal(x64Target.executable, 'whisper-server');
  assert.equal(x64Target.archiveType, 'tar.gz');

  const arm64Target = getRuntimeTarget('linux', 'arm64');
  assert.equal(arm64Target.kind, 'archive');
  assert.equal(arm64Target.executable, 'whisper-server');
  assert.equal(arm64Target.archiveType, 'tar.gz');
});
