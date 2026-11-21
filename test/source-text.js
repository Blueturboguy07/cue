// Helpers for tests that read cue's own source text (main.js, renderer.js,
// preload.js) and pick out a function or block. A Windows checkout with
// core.autocrlf has CRLF line ends, and the "\n}\n" style searches below
// would find nothing, so every read normalizes CRLF to LF first.
// (Not a test file: the test glob is test/*.test.js.)
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function readSource(rel) {
  return normalizeEol(fs.readFileSync(path.join(root, rel), 'utf8'));
}

// One function from a source text, from its head line to the closing brace at
// the same indent.
function fnFrom(src, head) {
  const start = src.indexOf(head);
  assert.ok(start > -1, `${head} not found`);
  const indent = head.match(/^\s*/)[0];
  const end = src.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > -1, `end of ${head} not found`);
  return src.slice(start, end + indent.length + 3);
}

module.exports = { root, normalizeEol, readSource, fnFrom };
