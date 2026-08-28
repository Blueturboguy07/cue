const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// Settings used to declare closeSettings twice. The async one waited for a
// successful save; the sync one always hid the modal. JavaScript kept the
// second, so Done / Escape / scrim-click discarded failed saves. This scan
// is the same shape as the Gemini-model drift tests: the renderer is not
// unit-testable without Electron, so we lock the wiring in source.

test('renderer defines closeSettings once', () => {
  const matches = source.match(/function closeSettings\s*\(/g) || [];
  assert.equal(matches.length, 1, `expected one closeSettings, found ${matches.length}`);
});

test('closeSettings awaits saveSettings before hiding the modal', () => {
  const match = source.match(/async function closeSettings\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'could not find async closeSettings body');
  const body = match[1];
  assert.match(body, /await saveSettings\(\)/);
  assert.match(body, /if \(await saveSettings\(\)\) scrim\.classList\.add\('hidden'\)/);
  assert.equal(body.includes("scrim.classList.add('hidden')"), true);
  assert.ok(
    !/saveSettings\(\);\s*scrim\.classList\.add\('hidden'\)/.test(body),
    'closeSettings must not hide the modal without awaiting saveSettings'
  );
});

test('Done, scrim-click, and Escape all go through closeSettings', () => {
  assert.match(source, /\$\('#s-close'\)\.addEventListener\('click',\s*\(\) => \{ void closeSettings\(\); \}\)/);
  assert.match(source, /if \(e\.target === scrim\) void closeSettings\(\)/);
  assert.match(
    source,
    /if \(e\.key === 'Escape' && !scrim\.classList\.contains\('hidden'\)\) void closeSettings\(\)/
  );
});
