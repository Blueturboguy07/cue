// Store schema versioning (src/store.js): cue-data.json gets stamped with the
// current schema version and old files are migrated forward on load.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Point the store at a temp data file so tests never touch real user data.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-'));
process.env.CUE_DATA_FILE = path.join(dir, 'cue-data.json');

// src/store.js requires electron at load; stub it (getPath is unused when the
// CUE_DATA_FILE override is set, but the require still needs to resolve).
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return origLoad.call(this, request, parent, isMain);
};
const store = require('../src/store.js');

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CUE_DATA_FILE;
});

function freshStore() {
  delete require.cache[require.resolve('../src/store.js')];
  return require('../src/store.js');
}

test('a fresh store reports the current schema version', () => {
  assert.strictEqual(store.getSettings().schemaVersion, store.SCHEMA_VERSION);
});

test('a versionless data file is migrated to the current version on load', () => {
  fs.writeFileSync(process.env.CUE_DATA_FILE, JSON.stringify({ resumeText: 'old resume' }));
  const fresh = freshStore();
  const s = fresh.getSettings();
  assert.strictEqual(s.schemaVersion, fresh.SCHEMA_VERSION);
  assert.strictEqual(s.resumeText, 'old resume'); // user data survives the migration
  assert.strictEqual(s.autoAnswer, false); // defaults still fill the gaps
});

test('a file already at the current version loads unchanged', () => {
  fs.writeFileSync(process.env.CUE_DATA_FILE, JSON.stringify({ schemaVersion: store.SCHEMA_VERSION, resumeText: 'newer resume' }));
  const fresh = freshStore();
  const s = fresh.getSettings();
  assert.strictEqual(s.schemaVersion, fresh.SCHEMA_VERSION);
  assert.strictEqual(s.resumeText, 'newer resume');
});

test('MIGRATIONS covers every version below the current one', () => {
  for (let v = 0; v < store.SCHEMA_VERSION; v++) {
    assert.strictEqual(typeof store.MIGRATIONS[v], 'function', `missing migration for version ${v}`);
  }
});

test('setSettings preserves the schema version', () => {
  const fresh = freshStore();
  const saved = fresh.setSettings({ resumeText: 'edited' });
  assert.strictEqual(saved.schemaVersion, fresh.SCHEMA_VERSION);
});
