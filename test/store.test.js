const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSettingsStore } = require('../src/settings-store-core');

function createTestDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('fresh install returns defaults and creates no files until a save', (context) => {
  const dir = createTestDirectory(context);
  const store = createSettingsStore(() => dir);
  assert.equal(store.getSettings().provider, 'openai');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('settings round-trip through disk, including nested merges', (context) => {
  const dir = createTestDirectory(context);
  createSettingsStore(() => dir).setSettings({
    apiKeys: { openai: 'sk-test' },
    smart: true,
    localWhisper: { modelId: 'large-v3' },
  });

  // A brand-new store instance simulates the next app launch.
  const reloaded = createSettingsStore(() => dir).getSettings();
  assert.equal(reloaded.apiKeys.openai, 'sk-test');
  assert.equal(reloaded.smart, true);
  assert.equal(reloaded.localWhisper.modelId, 'large-v3');
  // Unrelated defaults survive the merge.
  assert.equal(reloaded.provider, 'openai');
  assert.deepEqual(reloaded.models.gemini, { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' });
});

test('no temp file is left behind after a successful save', (context) => {
  const dir = createTestDirectory(context);
  const store = createSettingsStore(() => dir);
  // The very first save has no previous generation to back up; the .bak
  // appears once a live file exists to snapshot.
  store.setSettings({ smart: true });
  assert.deepEqual(fs.readdirSync(dir), ['cue-data.json']);
  store.setSettings({ smart: false });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cue-data.json', 'cue-data.json.bak']);
});

// The backup holds the PREVIOUS generation: save A then B leaves A in .bak and
// B in the live file. Recovery therefore restores A — strictly better than the
// old behavior of restoring blank defaults for every field.
test('a corrupt settings file is recovered from the backup generation', (context) => {
  const dir = createTestDirectory(context);
  const store = createSettingsStore(() => dir);
  store.setSettings({ apiKeys: { openai: 'sk-previous' } });
  store.setSettings({ apiKeys: { anthropic: 'sk-latest' } });
  assert.equal(store.getSettings().apiKeys.anthropic, 'sk-latest');

  // Simulate the crash mid-write that used to be permanent data loss.
  fs.writeFileSync(path.join(dir, 'cue-data.json'), '{"apiKeys":{"ope');

  const recovered = createSettingsStore(() => dir).getSettings();
  assert.equal(recovered.apiKeys.openai, 'sk-previous');
  assert.equal(recovered.apiKeys.anthropic, '');

  // Recovery heals the live file immediately.
  const healed = JSON.parse(fs.readFileSync(path.join(dir, 'cue-data.json'), 'utf8'));
  assert.equal(healed.apiKeys.openai, 'sk-previous');
});

test('corrupt file with no backup still loads cleanly from defaults', (context) => {
  const dir = createTestDirectory(context);
  fs.writeFileSync(path.join(dir, 'cue-data.json'), 'not json at all');
  const store = createSettingsStore(() => dir);
  assert.equal(store.getSettings().provider, 'openai');
  // And saving after that works again.
  store.setSettings({ apiKeys: { gemini: 'sk-fresh' } });
  const reloaded = JSON.parse(fs.readFileSync(path.join(dir, 'cue-data.json'), 'utf8'));
  assert.equal(reloaded.apiKeys.gemini, 'sk-fresh');
});

test('a failed save is reported via lastSaveError instead of being swallowed', (context) => {
  const missingDir = path.join(os.tmpdir(), 'cue-store-does-not-exist-' + process.pid);
  const store = createSettingsStore(() => missingDir);
  assert.equal(store.lastSaveError(), null);

  // The in-memory settings still update; only the write fails.
  const result = store.setSettings({ smart: true });
  assert.equal(result.smart, true);
  assert.ok(store.lastSaveError());
  assert.match(String(store.lastSaveError().message), /ENOENT/);
});

test('the aiRules cap still applies to stored settings', (context) => {
  const dir = createTestDirectory(context);
  const store = createSettingsStore(() => dir);
  const longRules = 'x'.repeat(3000);
  assert.equal(store.getSettings().aiRules.length, 0);
  store.setSettings({ aiRules: longRules });
  assert.equal(store.getSettings().aiRules.length, store.MAX_AI_RULES_CHARS);
});

test('afterMerge runs on writes only, never on values read from disk', (context) => {
  const dir = createTestDirectory(context);
  const trimmer = (s) => ({ ...s, baseUrl: String(s.baseUrl || '').trim() });
  const store = createSettingsStore(() => dir, { afterMerge: trimmer });

  store.setSettings({ baseUrl: '  http://localhost:11434/v1  ' });
  assert.equal(store.getSettings().baseUrl, 'http://localhost:11434/v1');

  // A value written to disk verbatim (bypassing setSettings) must load as-is.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cue-data.json'), 'utf8'));
  raw.baseUrl = '  http://unnormalized.example  ';
  fs.writeFileSync(path.join(dir, 'cue-data.json'), JSON.stringify(raw));
  assert.equal(createSettingsStore(() => dir, { afterMerge: trimmer }).getSettings().baseUrl,
    '  http://unnormalized.example  ');
});
