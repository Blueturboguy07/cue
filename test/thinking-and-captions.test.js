// Follow-ups to the empty-answers fix (coordinator, 2026-11-05):
// 1. A reasoning model can think for 90 s before it writes. Show "Thinking…"
//    in the answer area while only reasoning chunks arrive, never the
//    reasoning text, and replace it with the first answer token or with the
//    honest message.
// 2. A slide caption cut at its cap is trimmed and ends with "…", never with
//    the chat answer's "(Cut off: …)" note. The 25 s total timer stays.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const Module = require('node:module');

let created = null;
let chunks = [];
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: (req) => { created = req; return Promise.resolve(chunks); } } };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const { createLLM } = require('../src/llm');
const { readSource, fnFrom } = require('./source-text'); // CRLF-safe (Windows checkouts)
const mainSrc = readSource('main.js');
const rendererSrc = readSource('renderer/renderer.js');
const preloadSrc = readSource('preload.js');

const settings = {
  provider: 'publik', smart: false,
  apiKeys: { publik: 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345' },
  publik: { baseUrl: '' },
  models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } }
};
const text = (t) => ({ choices: [{ delta: { content: t } }] });
const thinking = (t) => ({ choices: [{ delta: { reasoning: t, reasoning_details: [{ type: 'reasoning.text', text: t }] } }] });
const finish = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const IMAGE = 'data:image/jpeg;base64,AAAA';

test.beforeEach(() => { created = null; chunks = [text('ok'), finish('stop')]; });

// ---- 1. "Thinking…" ---------------------------------------------------------

test('llm: each chunk reports its kind, so cue can tell thinking from answering', async () => {
  chunks = [thinking('a'), { choices: [{ delta: { reasoning_content: 'b' } }] }, text('Answer.'), finish('stop')];
  const kinds = [];
  await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {}, onActivity: (k) => kinds.push(k) });
  assert.deepEqual(kinds, ['thinking', 'thinking', 'text', 'other']);
});

test('main: "Thinking…" goes to the renderer while only reasoning arrives, at most every 5 s, never after the answer starts', () => {
  const start = mainSrc.indexOf('    let answerStarted = false;');
  assert.ok(start > -1, 'answerStarted not found in runFeature');
  const end = mainSrc.indexOf('\n    };\n', start);
  const block = mainSrc.slice(start, end + 7);
  let now = 1_000_000;
  const sent = [];
  let rearms = 0;
  const ctx = vm.createContext({
    streamSettled: false, THINKING_PING_MS: 5000,
    rearm: () => { rearms++; },
    send: (ch, payload) => sent.push([ch, payload]),
    Date: { now: () => now }
  });
  const run = vm.runInContext(`(function () { ${block}\n return { noteActivity, startAnswer: () => { answerStarted = true; } }; })()`, ctx);
  run.noteActivity('thinking');
  now += 1000; run.noteActivity('thinking');
  now += 4500; run.noteActivity('thinking');
  run.noteActivity('other');
  assert.equal(JSON.stringify(sent), JSON.stringify([['llm:thinking', {}], ['llm:thinking', {}]])); // vm objects: compare by value
  run.startAnswer();
  now += 10000; run.noteActivity('thinking');
  assert.equal(sent.length, 2, 'no "Thinking…" once answer text has started');
  assert.equal(rearms, 5, 'every chunk still re-arms the 25 s watchdog');
  assert.match(mainSrc, /onToken: \(t\) => \{ if \(streamSettled\) return; answerStarted = true;/);
  assert.match(mainSrc, /onActivity: noteActivity,/);
});

test('preload: the renderer may listen to llm:thinking', () => {
  assert.match(preloadSrc, /'llm:thinking'/);
});

function rendererHarness() {
  class El {
    constructor(tag) { this.tagName = tag; this.className = ''; this.textContent = ''; this.children = []; this.parentNode = null; this.dataset = {}; this.html = ''; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
    remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      for (const c of this.children) { if (c.className.split(' ').includes(cls)) return c; const r = c.querySelector(sel); if (r) return r; }
      return null;
    }
    set innerHTML(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this.html = v; }
    get innerHTML() { return this.html; }
    get shown() { return this.html + this.children.map((c) => c.textContent + (c.children.length ? c.shown : '')).join(''); }
  }
  const fns = ['  function showThinking() {', '  function clearThinking() {', '  function appendToken(t) {', '  function finalizeAi() {']
    .map((h) => fnFrom(rendererSrc, h)).join('\n');
  const ctx = vm.createContext({ document: { createElement: (t) => new El(t) }, renderMarkdown: (raw) => `<p>${raw}</p>`, startAi: () => { throw new Error('no bubble'); } });
  vm.runInContext(`var aiEl = null, caretEl = null;\n${fns}\nfunction newBubble() { aiEl = document.createElement('div'); aiEl.className = 'ai-text'; aiEl.dataset.raw = ''; caretEl = document.createElement('span'); caretEl.className = 'ai-caret'; aiEl.appendChild(caretEl); return aiEl; }`, ctx);
  return ctx;
}

test('renderer: "Thinking…" shows once, before the caret, while no answer text has come', () => {
  const r = rendererHarness();
  const bubble = r.newBubble();
  r.showThinking();
  r.showThinking();
  const marks = bubble.children.filter((c) => c.className === 'ai-thinking');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, 'Thinking…');
  assert.equal(bubble.children[bubble.children.length - 1].className, 'ai-caret');
});

test('renderer: the first answer token replaces "Thinking…"', () => {
  const r = rendererHarness();
  const bubble = r.newBubble();
  r.showThinking();
  r.appendToken('Two pointers.');
  assert.equal(bubble.querySelector('.ai-thinking'), null);
  assert.equal(bubble.dataset.raw, 'Two pointers.');
  assert.ok(!bubble.shown.includes('Thinking'));
  r.showThinking(); // a late reasoning chunk after the answer started
  assert.equal(bubble.querySelector('.ai-thinking'), null);
});

test('renderer: the honest message replaces "Thinking…" (the llm:error path)', () => {
  const r = rendererHarness();
  const bubble = r.newBubble();
  r.showThinking();
  const msg = 'No answer this time: the model used its whole length limit on thinking and wrote nothing.';
  bubble.dataset.raw = msg; // what the llm:error handler does, then finalizeAi()
  r.finalizeAi();
  assert.equal(bubble.children.length, 0);
  assert.equal(bubble.shown, `<p>${msg}</p>`);
});

test('renderer: llm:thinking shows the placeholder and keeps the busy failsafe away', () => {
  const start = rendererSrc.indexOf("cue.on('llm:thinking'");
  assert.ok(start > -1, 'llm:thinking handler not found');
  const handler = rendererSrc.slice(start, rendererSrc.indexOf("cue.on('", start + 10));
  assert.match(handler, /showThinking\(\);/);
  assert.match(handler, /onAnswerActivity\(\);/);
});

// ---- 2. slide captions ------------------------------------------------------

test('a slide caption cut at its cap is trimmed and ends with "…", with no cut-off note', async () => {
  chunks = [thinking('look'), text('Q3 revenue grew 12%, '), finish('length')];
  const got = [];
  const caption = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis', onToken: (t) => got.push(t) });
  assert.equal(caption, 'Q3 revenue grew 12%…');
  assert.ok(!got.join('').includes('Cut off'));
  assert.equal(created.model, 'publik-balanced');
  assert.equal(created.max_tokens, 300 + 4096);
});

test('a whole slide caption is unchanged', async () => {
  chunks = [text('Q3 revenue grew 12%.'), finish('stop')];
  const caption = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis', onToken: () => {} });
  assert.equal(caption, 'Q3 revenue grew 12%.');
});

test('main: captionSlide asks for the "…" cut and keeps its fixed 25 s total timer', () => {
  const fn = fnFrom(mainSrc, 'async function captionSlide(imageDataUrl, transcriptSlice) {');
  assert.match(fn, /lengthCut: 'ellipsis',/);
  assert.match(fn, /maxTokens: 300,/);
  assert.match(fn, /giveUpTimer\(STREAM_INACTIVITY_MS, 'slide caption timed out'\)/);
  assert.ok(!/onActivity|rearm/.test(fn), 'the caption timer is a total limit: nothing re-arms it');
});
