const test = require('node:test');
const assert = require('node:assert');
const { buildNotesPrompt, parseNotes } = require('../src/notes');

const transcript = [
  { channel: 'them', text: 'We need to launch by Friday.', ts: 1 },
  { channel: 'you', text: 'I can handle the API work.', ts: 2 },
  { channel: 'them', text: 'Send the release notes to eng.', ts: 3 }
];

test('buildNotesPrompt formats speakers and preserves order', () => {
  const p = buildNotesPrompt(transcript);
  assert.ok(p.includes('Them: We need to launch by Friday.'));
  assert.ok(p.includes('You: I can handle the API work.'));
  assert.ok(p.includes('Action Items:'));
});

test('parseNotes extracts all five sections', () => {
  const blob = [
    'Meeting Summary:',
    'Ship Friday.',
    '',
    'Key Points:',
    '- launch Friday',
    '- API by me',
    '',
    'Decisions:',
    '- no scope creep',
    '',
    'Action Items:',
    '- send release notes',
    '',
    'Follow-Up:',
    '- confirm with eng'
  ].join('\n');
  const n = parseNotes(blob);
  assert.strictEqual(n.summary, 'Ship Friday.');
  assert.deepStrictEqual(n.keyPoints, ['launch Friday', 'API by me']);
  assert.deepStrictEqual(n.decisions, ['no scope creep']);
  assert.deepStrictEqual(n.actionItems, ['send release notes']);
  assert.deepStrictEqual(n.followUp, ['confirm with eng']);
});

test('parseNotes strips bullets and numeric prefixes', () => {
  const n = parseNotes('Action Items:\n- [ ] email\n1. call\n');
  assert.deepStrictEqual(n.actionItems, ['email', 'call']);
});

test('parseNotes falls back to summary when the model ignores headings', () => {
  const n = parseNotes('Just a plain recap paragraph with no structure here.');
  assert.strictEqual(n.summary, 'Just a plain recap paragraph with no structure here.');
});

test('parseNotes returns empty on blank input', () => {
  assert.deepStrictEqual(parseNotes(''), { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
});