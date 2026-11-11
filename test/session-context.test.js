const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionContext, MAX_FILES, MAX_FILE_CHARS } = require('../src/session-context');
const { parseDocumentFile } = require('../src/resume');

const RESUME = [
  'Jane Doe', 'Experience',
  'NVIDIA, Senior Engineer 2021-2024: built CUDA kernels in C++ and moved training to PyTorch, cutting step time 38%.',
  'Acme Corp, Engineer 2018-2021: led the Kubernetes migration.',
  'Skills: Python, CUDA, Kubernetes'
].join('\n');

const turn = (text, channel = 'them', ts = Date.now()) => ({ channel, text, ts });
const withResume = () => { const c = createSessionContext(); c.add('resume.pdf', RESUME); return c; };
const ask = (c, text, extra = {}) => c.forQuestion({ mode: 'say', transcript: [turn(text)], userText: '', ...extra });

test('questions about the user are grounded in the files, including vague ones', () => {
  const c = withResume();
  for (const q of [
    'What did you do at NVIDIA?',
    'Tell me about your experience with CUDA.',
    'Walk me through your resume.',
    'Why did you leave Acme?',
    'And the Kubernetes migration, how did that go?',
  ]) {
    const r = ask(c, q);
    assert.ok(r, q);
    assert.match(r.block, /BEGIN FILE: resume\.pdf/);
    assert.match(r.block, /cutting step time 38%/);
    assert.deepEqual(r.files, ['resume.pdf']);
  }
});

test('unrelated questions are left completely alone', () => {
  const c = withResume();
  for (const q of [
    'What is the expected number of coin flips to get two heads in a row?',
    'A stock has 20% volatility and a 5% rate. What is the one year at the money call price?',
    'How would you price a European option?',
    'Explain the central limit theorem.',
    'Given two sorted arrays, how do you find the median?',
  ]) assert.equal(ask(c, q), null, q);
});

test('only the newest question counts: a quant question after a resume question gets no files', () => {
  const c = withResume();
  const now = Date.now();
  const transcript = [
    turn('What did you do at NVIDIA?', 'them', now - 60000),
    turn('I built CUDA kernels.', 'you', now - 50000),
    turn('Nice. What is the expected value of a fair die roll?', 'them', now - 1000),
  ];
  assert.equal(c.forQuestion({ mode: 'say', transcript, userText: '' }), null);
});

test('a proper noun shared with the files counts as related, unless the question just explains a topic', () => {
  const c = withResume();
  assert.ok(ask(c, 'Any thoughts on Kubernetes versus Nomad?'));
  assert.equal(ask(c, 'How does PyTorch autograd work?'), null);
});

test('Ask and Answer this judge the typed or clicked question, not the transcript', () => {
  const c = withResume();
  const quant = [turn('What did you do at NVIDIA?')];
  assert.equal(c.forQuestion({ mode: 'ask', transcript: quant, userText: 'What is 17 times 23?' }), null);
  assert.ok(c.forQuestion({ mode: 'ask', transcript: [], userText: 'Summarize my resume' }));
  assert.ok(c.forQuestion({ mode: 'answerThis', transcript: [], userText: 'What was your role at NVIDIA?' }));
});

test('coding-problem and recap modes never get files', () => {
  const c = withResume();
  for (const mode of ['leetcode', 'recap']) {
    assert.equal(c.forQuestion({ mode, transcript: [turn('What did you do at NVIDIA?')], userText: 'What did you do at NVIDIA?' }), null);
  }
});

test('the web-search sentence appears only when the provider can search', () => {
  const c = withResume();
  const q = 'What did you do at NVIDIA?';
  const on = ask(c, q, { webSearch: true });
  const off = ask(c, q, { webSearch: false });
  assert.equal(on.webSearch, true);
  assert.match(on.block, /search the web/);
  assert.equal(off.webSearch, false);
  assert.doesNotMatch(off.block, /search the web/);
  assert.match(off.block, /invent nothing about the user/);
});

test('no files, no effect', () => {
  assert.equal(ask(createSessionContext(), 'What did you do at NVIDIA?'), null);
});

test('files can be added, replaced by name, removed and cleared', () => {
  const c = createSessionContext();
  c.add('a.txt', 'alpha'); c.add('b.txt', 'beta'); c.add('a.txt', 'alpha two');
  assert.deepEqual(c.list().map((f) => f.name), ['b.txt', 'a.txt']);
  c.remove(c.list()[0].id);
  assert.deepEqual(c.list().map((f) => f.name), ['a.txt']);
  c.clear();
  assert.deepEqual(c.list(), []);
});

test('rejects empty files and more than the file limit', () => {
  const c = createSessionContext();
  assert.throws(() => c.add('scan.pdf', '  \n '), /No readable text in scan\.pdf/);
  for (let i = 0; i < MAX_FILES; i++) c.add('f' + i, 'text ' + i);
  assert.throws(() => c.add('extra', 'text'), /At most 5 files/);
});

test('a very long file is cut and flagged', () => {
  const c = createSessionContext();
  c.add('long.txt', 'x'.repeat(MAX_FILE_CHARS + 500));
  const [f] = c.list();
  assert.equal(f.truncated, true);
  assert.equal(f.chars, MAX_FILE_CHARS + 500);
  assert.equal(ask(c, 'Tell me about your resume').block.includes('x'.repeat(MAX_FILE_CHARS + 1)), false);
});

test('listing exposes names and sizes only, never the text', () => {
  const c = withResume();
  assert.deepEqual(Object.keys(c.list()[0]).sort(), ['chars', 'id', 'name', 'truncated']);
});

test('parseDocumentFile reads text files and explains what it cannot read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-ctx-'));
  const txt = path.join(dir, 'notes.md'); fs.writeFileSync(txt, '# Notes\nship it\n');
  assert.equal(await parseDocumentFile(txt), '# Notes\nship it');
  const doc = path.join(dir, 'old.doc'); fs.writeFileSync(doc, 'x');
  await assert.rejects(parseDocumentFile(doc), /\.docx or PDF/);
  const exe = path.join(dir, 'a.exe'); fs.writeFileSync(exe, 'x');
  await assert.rejects(parseDocumentFile(exe), /Unsupported file type: \.exe/);
});
