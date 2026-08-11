// Tripwire: no duplicate function declarations in renderer.js.
// The IIFE scope hoists all function declarations to the top, so two declarations
// of the same name silently shadow each other — the later one wins for every call
// site, even those above it. This test catches that class of bug before merge.
// (The settings-panel scripts, icons.js, etc., are intentionally smaller and
// don't carry the same shadowing risk.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'renderer', 'renderer.js')
];

for (const file of files) {
  test(`no duplicate function declarations in ${path.basename(file)}`, () => {
    const src = fs.readFileSync(file, 'utf8');
    const names = [];
    // Match "function name(" or "async function name(" — captures the name.
    const re = /(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) names.push(m[1]);
    const counts = {};
    names.forEach((n) => (counts[n] = (counts[n] || 0) + 1));
    const dupes = Object.entries(counts)
      .filter(([, c]) => c > 1)
      .map(([n, c]) => `${n} (${c}\u00d7)`);
    assert.deepStrictEqual(dupes, [], `duplicate function declarations found: ${dupes.join(', ')}`);
  });
}
