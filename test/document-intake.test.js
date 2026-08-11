// Document-intake core (renderer/document-intake.js): the pure state machine behind
// the import UI — sanitize, append, merge, remove, delete, clear, status copy.
global.window = {};
require('../renderer/document-intake.js');
const DI = window.CueDocumentIntake;
const { test } = require('node:test');
const assert = require('node:assert');

test('sanitizeList drops junk and normalizes entries to { fileName, text }', () => {
  assert.deepStrictEqual(DI.sanitizeList(null), []);
  assert.deepStrictEqual(DI.sanitizeList(undefined), []);
  assert.deepStrictEqual(DI.sanitizeList('nope'), []);
  assert.deepStrictEqual(DI.sanitizeList([null, 5, { fileName: 'a.pdf', text: 'A' }, { fileName: 'b.pdf' }]), [
    { fileName: 'a.pdf', text: 'A' },
    { fileName: 'b.pdf', text: undefined }
  ]);
});

test('appendFiles concatenates and computes the joined added text', () => {
  const files = [
    { fileName: 'a.pdf', text: 'One' },
    { fileName: 'b.txt', text: '' },
    { fileName: 'c.pdf', text: 'Two' }
  ];
  const { list, addedText } = DI.appendFiles([{ fileName: 'old.pdf', text: 'Old' }], files);
  assert.strictEqual(list.length, 4);
  assert.strictEqual(list[3].fileName, 'c.pdf');
  // empty-text files contribute to the list but not to the merged text
  assert.strictEqual(addedText, 'One\n\nTwo');
});

test('mergeIntoValue preserves existing content and appends without clobbering', () => {
  assert.strictEqual(DI.mergeIntoValue('', 'Added'), 'Added');
  assert.strictEqual(DI.mergeIntoValue(null, 'Added'), 'Added');
  assert.strictEqual(DI.mergeIntoValue('  Pasted  ', 'Added'), 'Pasted\n\nAdded');
  assert.strictEqual(DI.mergeIntoValue('Existing', ''), 'Existing');
  assert.strictEqual(DI.mergeIntoValue('Existing', null), 'Existing');
});

test('removeFileText removes the file text wherever it sits', () => {
  assert.strictEqual(DI.removeFileText('file\n\nmanual', 'file'), 'manual');
  assert.strictEqual(DI.removeFileText('manual\n\nfile', 'file'), 'manual');
  assert.strictEqual(DI.removeFileText('manual\n\nfile\n\nother', 'file'), 'manual\n\nother');
});

test('removeFileText leaves the value untouched when the text was edited away', () => {
  assert.strictEqual(DI.removeFileText('user edited the file text', 'original file text'), 'user edited the file text');
});

test('removeFileText removes the last occurrence when a file text appears twice', () => {
  // The last occurrence is the file's own appended copy; the earlier one (which
  // happens to share the same text) is the user's content and stays.
  assert.strictEqual(DI.removeFileText('dup\n\nfile\n\nmanual\n\nfile', 'file'), 'dup\n\nfile\n\nmanual');
});

test('removeFileText with empty text is a no-op', () => {
  assert.strictEqual(DI.removeFileText('anything', ''), 'anything');
  assert.strictEqual(DI.removeFileText('anything', null), 'anything');
});

test('deleteFile removes the row and its text', () => {
  const list = [
    { fileName: 'a.pdf', text: 'A' },
    { fileName: 'b.pdf', text: 'B' }
  ];
  const { list: next, value } = DI.deleteFile(list, 0, 'manual\n\nA\n\nB');
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].fileName, 'b.pdf');
  assert.strictEqual(value, 'manual\n\nB');
});

test('deleteFile removes the row but leaves the value when the text was edited away', () => {
  const list = [{ fileName: 'a.pdf', text: 'ORIGINAL' }];
  const { list: next, value } = DI.deleteFile(list, 0, 'I rewrote this');
  assert.deepStrictEqual(next, []);
  assert.strictEqual(value, 'I rewrote this');
});

test('deleteFile with an out-of-range index changes nothing', () => {
  const list = [{ fileName: 'a.pdf', text: 'A' }];
  const { list: next, value } = DI.deleteFile(list, 5, 'manual');
  assert.strictEqual(next, list); // same reference — caller can detect "no such row"
  assert.strictEqual(value, 'manual');
});

test('clearField empties both the list and the value', () => {
  assert.deepStrictEqual(DI.clearField(), { list: [], value: '' });
});

test('hasContent ignores empty and whitespace-only values', () => {
  assert.strictEqual(DI.hasContent(''), false);
  assert.strictEqual(DI.hasContent('   \n  '), false);
  assert.strictEqual(DI.hasContent(null), false);
  assert.strictEqual(DI.hasContent('text'), true);
});

test('importStatus reports success, partial failure, and nothing', () => {
  const files = [{ fileName: 'a.pdf', text: 'A' }, { fileName: 'b.pdf', text: 'B' }];
  const errors = [{ fileName: 'bad.pdf', error: 'File too large' }];
  assert.strictEqual(DI.importStatus('resume', [files[0]], []), 'Imported a.pdf — press Done to save.');
  assert.strictEqual(DI.importStatus('jd', files, []), 'Imported 2 files — press Done to save.');
  assert.strictEqual(
    DI.importStatus('projectNotes', files, errors),
    'Document import: 2 of 3 succeeded; bad.pdf failed — File too large'
  );
  assert.strictEqual(DI.importStatus('resume', [], []), null);
  assert.strictEqual(DI.importStatus('unknown', [], []), null);
});
