// Guards around document parsing (src/resume.js): size limits and text truncation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDocumentFile, truncateText, MAX_TEXT_CHARS, MAX_FILE_BYTES } = require('../src/resume');

test('truncateText returns short text unchanged', () => {
  assert.strictEqual(truncateText('hello'), 'hello');
});

test('truncateText returns empty string for missing input', () => {
  assert.strictEqual(truncateText(''), '');
  assert.strictEqual(truncateText(null), '');
  assert.strictEqual(truncateText(undefined), '');
});

test('truncateText caps long text and appends a visible notice', () => {
  const long = 'a'.repeat(MAX_TEXT_CHARS + 500);
  const out = truncateText(long);
  assert.ok(out.startsWith('a'.repeat(MAX_TEXT_CHARS)), 'keeps the first MAX_TEXT_CHARS chars');
  assert.ok(out.length < long.length, 'output is shorter than the input');
  assert.ok(out.includes('[truncated:'), 'notice is included so the user knows text was cut');
});

test('truncateText honors a custom max', () => {
  const out = truncateText('abcdef', 3);
  assert.strictEqual(out.slice(0, 3), 'abc');
  assert.ok(out.includes('[truncated:'));
});

test('parseDocumentFile rejects unsupported extensions before touching the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-resume-'));
  const f = path.join(dir, 'notes.txt');
  fs.writeFileSync(f, 'hello');
  try {
    await assert.rejects(parseDocumentFile(f), /Unsupported file type/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDocumentFile rejects files over the size cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-resume-'));
  const f = path.join(dir, 'big.pdf');
  fs.writeFileSync(f, Buffer.alloc(MAX_FILE_BYTES + 1));
  try {
    await assert.rejects(parseDocumentFile(f), /File too large/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
