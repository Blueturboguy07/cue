const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadMain } = require('./helpers/main-harness');

const RESUME = 'Jane Doe\nNVIDIA, Senior Engineer 2021-2024: built CUDA kernels, cut training step time 38%.\nAcme Corp 2018-2021: led the Kubernetes migration.';

// main.js runs inside a vm context, so its arrays and objects have a different prototype.
const plain = (x) => JSON.parse(JSON.stringify(x));

function setup({ contextMode, webSearch = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-ctxmode-'));
  const file = path.join(dir, 'resume.txt');
  fs.writeFileSync(file, RESUME);
  const calls = [];
  const h = loadMain({
    settings: { contextMode },
    electron: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) } },
    modules: { './src/llm': { createLLM: () => ({ ready: true, webSearch, stream: async (p) => { calls.push(p); return 'answer'; } }) } },
  });
  return { h, calls };
}

async function load(h) {
  const res = await h.handlers.get('context:pick')();
  assert.deepEqual(plain(res.errors), []);
  assert.deepEqual(res.files.map((f) => f.name), ['resume.txt']);
}

const say = async (h, question) => {
  h.transcript.length = 0;
  h.transcript.push({ channel: 'them', text: question, ts: Date.now() });
  await h.runFeature('say', '');
};

test('context mode on: a question about the user gets the files, a web-search flag and a UI tag', async () => {
  const { h, calls } = setup({ contextMode: true });
  await load(h);
  await say(h, 'What did you do at NVIDIA?');
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /cut training step time 38%/);
  assert.equal(calls[0].webSearch, true);
  assert.deepEqual(plain(h.events.find((e) => e.channel === 'llm:start').data.context), ['resume.txt']);
});

test('context mode on: a quant question gets byte-identical output to context mode off', async () => {
  const quant = 'What is the expected number of coin flips to get two heads in a row?';
  const on = setup({ contextMode: true });
  await load(on.h);
  await say(on.h, quant);
  const off = setup({ contextMode: false });
  await load(off.h);
  await say(off.h, quant);
  assert.equal(on.calls[0].system, off.calls[0].system);
  assert.deepEqual(plain(on.calls[0].turns), plain(off.calls[0].turns));
  assert.equal(on.calls[0].webSearch, false);
  assert.equal(on.h.events.find((e) => e.channel === 'llm:start').data.context, null);
});

test('context mode off: loaded files are never used, even for a question about them', async () => {
  const { h, calls } = setup({ contextMode: false });
  await load(h);
  await say(h, 'What did you do at NVIDIA?');
  assert.doesNotMatch(calls[0].system, /step time 38%/);
  assert.equal(calls[0].webSearch, false);
});

test('a provider without web search still gets the files, and no search request', async () => {
  const { h, calls } = setup({ contextMode: true, webSearch: false });
  await load(h);
  await say(h, 'What did you do at NVIDIA?');
  assert.match(calls[0].system, /step time 38%/);
  assert.equal(calls[0].webSearch, false);
  assert.doesNotMatch(calls[0].system, /search the web/);
});

test('Clear History drops the meeting\'s files', async () => {
  const { h, calls } = setup({ contextMode: true });
  await load(h);
  await h.handlers.get('transcript:clear')();
  assert.deepEqual(plain(await h.handlers.get('context:list')()), []);
  await say(h, 'What did you do at NVIDIA?');
  assert.doesNotMatch(calls[0].system, /step time 38%/);
});

test('a file that cannot be read is reported, not added', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-ctxmode-'));
  const bad = path.join(dir, 'photo.png'); fs.writeFileSync(bad, 'x');
  const h = loadMain({ electron: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [bad] }) } } });
  const res = await h.handlers.get('context:pick')();
  assert.deepEqual(res.files, []);
  assert.match(res.errors[0].message, /Unsupported file type: \.png/);
});
