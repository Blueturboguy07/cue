// Content-filter and other non-normal stops (NitroAI smoke, 2026-11-05).
// publik-balanced (xiaomi/mimo-v2.6-pro, OpenRouter its only host) sometimes
// refuses harmless content: it streams "The request was rejected because it
// was considered high risk" as normal content, alone or glued mid-word to a
// partial answer, then finish_reason "content_filter". cue 0.2.12 showed that
// sentence as the answer, gave a partial answer no note, read no stop reason
// on the Anthropic and Gemini paths, and stored the sentence as meeting notes.
// Only a clean stop is a whole answer now.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

let requests = [];      // every OpenAI-style request cue sent
let replies = [];       // per request: an array of chunks, or an Error to reject with
let anthropicEvents = [];
let geminiChunks = [];
const originalModuleLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: (req) => {
          requests.push(req);
          const reply = replies.length ? replies.shift() : [text('ok'), finish('stop')];
          return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
        } } };
      }
    };
  }
  if (request === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor() { this.messages = { create: () => Promise.resolve(anthropicEvents) }; }
    };
  }
  if (request === '@google/genai') {
    return { GoogleGenAI: class FakeGenAI {
      constructor() { this.models = { generateContentStream: () => Promise.resolve(geminiChunks) }; }
    } };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const llmModule = require('../src/llm');
const {
  createLLM, LENGTH_CUT_NOTE, LENGTH_EMPTY_MESSAGE, EMPTY_ANSWER_MESSAGE
} = llmModule;
const { createMeetingStore } = require('../src/meetings');
const { createMeetingMemory } = require('../src/meeting-memory');

// The notes and messages, spelled out here so this file fails on a build
// that does not have them (fbd52fe exports none of them).
const FILTER_EMPTY = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const FILTER_NOTE = "\n\n(Incomplete: the AI provider's safety filter stopped this answer. Ask again with different words to get the rest.)";
const RECITATION_EMPTY = 'The AI provider stopped this answer because it repeated published text. Ask again with different words.';
const RECITATION_NOTE = '\n\n(Incomplete: the AI provider stopped this answer because it repeated published text.)';
const INCOMPLETE_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';
const REFUSAL = 'The request was rejected because it was considered high risk';

const PUBLIK_KEY = 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345';
function publikSettings(overrides = {}) {
  return {
    provider: 'publik', smart: false,
    apiKeys: { publik: PUBLIK_KEY, openai: 'sk-own', anthropic: 'sk-ant-own', gemini: 'g-own', azure: 'az-own' },
    publik: { baseUrl: '', claimState: 'claimed' },
    azureEndpoint: 'https://cue-test.cognitiveservices.azure.com',
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' }, openai: { fast: 'gpt-own', smart: 'gpt-own' } },
    ...overrides
  };
}
const anonymous = { baseUrl: '', claimState: 'anonymous' };
// OpenRouter's stream shape: content deltas, then a chunk with only the
// finish_reason (and usage).
function text(t) { return { choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }; }
function finish(reason) { return { choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 900, completion_tokens: 40 } }; }
const IMAGE = 'data:image/jpeg;base64,AAAA';

async function ask(settings, params = {}) {
  const tokens = [];
  const retries = [];
  const llm = createLLM(settings);
  let result;
  let error = null;
  try {
    result = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: (t) => tokens.push(t), onRetry: (r) => retries.push(r), ...params });
  } catch (e) {
    error = e;
  }
  return { result, error, shown: tokens.join(''), tokens, retries };
}

test.beforeEach(() => { requests = []; replies = []; anthropicEvents = []; geminiChunks = []; });

// ---- OpenAI-style path: the refusal sentence is never the answer ------------

test('refusal deltas then content_filter: no refusal text shown, the honest safety-filter message instead', async () => {
  replies = [[text('The request was rejected because it was considered high risk'), finish('content_filter')]];
  const { result, error, shown } = await ask(publikSettings());
  assert.equal(result, undefined);
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(error.emptyAnswer, true);
  assert.equal(error.finishReason, 'content_filter');
  assert.equal(shown, '');
});

test('a refusal sentence split across deltas is still held back and dropped', async () => {
  replies = [[text('The req'), text('uest was rejected bec'), text('ause it was consid'), text('ered high risk'), finish('content_filter')]];
  const { error, shown } = await ask(publikSettings());
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(shown, '');
});

test('partial answer then the refusal glued mid-word: the partial stays, the sentence goes, the note says why', async () => {
  replies = [[
    text('Capillary action lifts the wax because of the streaming of the ascending'),
    text('The request was rejected because it was considered high risk'),
    finish('content_filter')
  ]];
  const { result, error, shown } = await ask(publikSettings());
  assert.equal(error, null);
  assert.equal(result, 'Capillary action lifts the wax because of the streaming of the ascending' + FILTER_NOTE);
  assert.equal(shown, result);
  assert.doesNotMatch(shown, /rejected|high risk/);
});

test('the refusal glued mid-word inside one delta (with a period) is dropped too', async () => {
  replies = [[text('The cup holds the mThe request was rejected because it was considered high risk.'), finish('content_filter')]];
  const { result, shown } = await ask(publikSettings());
  assert.equal(result, 'The cup holds the m' + FILTER_NOTE);
  assert.doesNotMatch(shown, /rejected/);
});

test('a refusal sentence that ends with "stop" (no content_filter) still counts as refused', async () => {
  replies = [[text('Wax vapour burns. '), text(REFUSAL), finish('stop')]];
  const { result } = await ask(publikSettings());
  assert.equal(result, 'Wax vapour burns. ' + FILTER_NOTE);
});

test('content_filter after a partial answer with no refusal sentence: the partial gets the safety-filter note', async () => {
  replies = [[text('The flame needs air from'), finish('content_filter')]];
  const { result, shown } = await ask(publikSettings());
  assert.equal(result, 'The flame needs air from' + FILTER_NOTE);
  assert.equal(shown, result);
});

test('content_filter with no text at all: the safety-filter message, not "empty answer"', async () => {
  replies = [[finish('content_filter')]];
  const { error } = await ask(publikSettings());
  assert.equal(error.message, FILTER_EMPTY);
});

test('a stream that ends with no finish reason is incomplete and says so', async () => {
  replies = [[text('The wick draws the melted wax up')]];
  const { result, shown } = await ask(publikSettings());
  assert.equal(result, 'The wick draws the melted wax up' + INCOMPLETE_NOTE);
  assert.equal(shown, result);
});

test('finish_reason "error" (OpenRouter mid-stream error) is incomplete and says so', async () => {
  replies = [[text('Part one of the answer'), finish('error')]];
  const { result } = await ask(publikSettings());
  assert.equal(result, 'Part one of the answer' + INCOMPLETE_NOTE);
});

test('a stream with no text and no finish reason keeps the plain empty-answer message', async () => {
  replies = [[]];
  const { error } = await ask(publikSettings());
  assert.equal(error.message, EMPTY_ANSWER_MESSAGE);
});

test('a clean answer that only starts like the refusal reaches the screen whole', async () => {
  replies = [[text('The request was '), text('approved on Tuesday. The req'), text('uest form is online.'), finish('stop')]];
  const { result, shown, tokens } = await ask(publikSettings());
  assert.equal(result, 'The request was approved on Tuesday. The request form is online.');
  assert.equal(shown, result);
  assert.ok(tokens.length >= 2, 'text still streams in pieces');
});

test('a refusal message quoted inside an answer is content: it is shown and the answer is whole', async () => {
  const answer = 'That error, "The request was rejected because it was considered high risk", comes from the provider. Ask again.';
  replies = [[text(answer.slice(0, 30)), text(answer.slice(30, 70)), text(answer.slice(70)), finish('stop')]];
  const { result, shown } = await ask(publikSettings());
  assert.equal(result, answer);
  assert.equal(shown, answer);
});

test('the other known provider refusals at the end are dropped too (DeepSeek, Qwen, Zhipu)', async () => {
  replies = [[text('Part of it.Content Exists Risk'), finish('content_filter')]];
  assert.equal((await ask(publikSettings())).result, 'Part of it.' + FILTER_NOTE);
  replies = [[text('Some notes. OUTPUT DATA MAY CONTAIN INAPPROPRIATE CONTENT.'), finish('stop')]];
  assert.equal((await ask(publikSettings())).result, 'Some notes. ' + FILTER_NOTE);
  replies = [[text('系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。'), finish('stop')]];
  const zhipu = await ask(publikSettings());
  assert.equal(zhipu.error.message, FILTER_EMPTY);
  assert.equal(zhipu.shown, '');
});

test('any split of the stream into deltas gives the same shown text', () => {
  const { refusalFilter } = llmModule;
  const cases = [
    ['streaming of the ascendingThe request was rejected because it was considered high risk', 'streaming of the ascending', true],
    ['The cup holds the The request was rejected because it was considered high risk.\n', 'The cup holds the ', true],
    ['Quote: The request was rejected because it was considered high risk, then more.', 'Quote: The request was rejected because it was considered high risk, then more.', false],
    ['The request was approved.', 'The request was approved.', false]
  ];
  for (const [input, want, wantRefused] of cases) {
    for (let i = 0; i <= input.length; i++) {
      for (let j = i; j <= input.length; j += 7) {
        const f = refusalFilter();
        const shown = f.push(input.slice(0, i)) + f.push(input.slice(i, j)) + f.push(input.slice(j)) + f.end();
        assert.equal(shown, want, `split at ${i}/${j}`);
        assert.equal(f.refused, wantRefused, `split at ${i}/${j}`);
      }
    }
  }
});

test('the length behavior stays: a cut answer gets the length note, an all-thinking one the length message', async () => {
  replies = [[text('A long answer'), finish('length')]];
  assert.equal((await ask(publikSettings())).result, 'A long answer' + LENGTH_CUT_NOTE);
  replies = [[finish('length')]];
  assert.equal((await ask(publikSettings())).error.message, LENGTH_EMPTY_MESSAGE);
});

test('Azure path: content_filter after a partial answer gets the safety-filter note', async () => {
  replies = [[text('Azure partial'), finish('content_filter')]];
  const { result } = await ask(publikSettings({ provider: 'azure', models: { azure: { fast: 'gpt-own', smart: 'gpt-own' } } }));
  assert.equal(result, 'Azure partial' + FILTER_NOTE);
});

// ---- one retry, only where it is cheap and safe -------------------------------

test('publik-balanced refused with nothing shown (linked install): asked once more on publik-smart', async () => {
  replies = [[text(REFUSAL), finish('content_filter')], [text('Smart answer.'), finish('stop')]];
  const { result, shown, retries } = await ask(publikSettings({ smart: true }));
  assert.equal(result, 'Smart answer.');
  assert.equal(shown, 'Smart answer.');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-smart']);
  assert.equal(requests[1].max_tokens, 1400 + 4096);
  assert.deepEqual(retries, [{ from: 'publik-balanced', to: 'publik-smart', finishReason: 'content_filter' }]);
});

test('a refused screenshot question (fast tier, linked) is asked once more on publik-smart with the same image', async () => {
  replies = [[text(REFUSAL), finish('content_filter')], [text('It is a LinkedIn profile.'), finish('stop')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(result, 'It is a LinkedIn profile.');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-smart']);
  const image = (r) => r.messages[r.messages.length - 1].content.find((p) => p.type === 'image_url').image_url.url;
  assert.equal(image(requests[1]), IMAGE);
});

test('an unlinked install: a refused text question is asked once more on publik-fast', async () => {
  replies = [[text(REFUSAL), finish('content_filter')], [text('Fast answer.'), finish('stop')]];
  const { result } = await ask(publikSettings({ smart: true, publik: anonymous }));
  assert.equal(result, 'Fast answer.');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-fast']);
  assert.equal(requests[1].max_tokens, 1400 + 2048);
});

test('an unlinked install: a refused screenshot question is not asked again (publik-fast cannot read it): honest message', async () => {
  replies = [[text(REFUSAL), finish('content_filter')]];
  const { error } = await ask(publikSettings({ publik: anonymous }), { imageDataUrl: IMAGE });
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(requests.length, 1);
});

test('no retry after a partial answer was shown: the partial stays, with the note', async () => {
  replies = [[text('Half of it'), text(REFUSAL), finish('content_filter')]];
  const { result } = await ask(publikSettings({ smart: true }));
  assert.equal(result, 'Half of it' + FILTER_NOTE);
  assert.equal(requests.length, 1);
});

test('the retry is refused too: one retry only, then the honest message', async () => {
  replies = [[text(REFUSAL), finish('content_filter')], [finish('content_filter')], [text('never asked'), finish('stop')]];
  const { error } = await ask(publikSettings({ smart: true }));
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(requests.length, 2);
});

test('the retry fails for another reason (402): the first, honest message stands', async () => {
  const noCredit = new Error('402 insufficient credit');
  noCredit.status = 402;
  noCredit.error = { type: 'insufficient_credit', message: 'Not enough credit.' };
  replies = [[text(REFUSAL), finish('content_filter')], noCredit];
  const { error } = await ask(publikSettings({ smart: true }));
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(requests.length, 2);
});

test('publik-fast refused: no retry (only publik-balanced is asked again)', async () => {
  replies = [[text(REFUSAL), finish('content_filter')]];
  const { error } = await ask(publikSettings());
  assert.equal(error.message, FILTER_EMPTY);
  assert.deepEqual(requests.map((r) => r.model), ['publik-fast']);
});

test('an own OpenAI key refused: no retry on publik', async () => {
  replies = [[finish('content_filter')]];
  const { error } = await ask(publikSettings({ provider: 'openai', smart: true }));
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(requests.length, 1);
});

test('a length-empty publik-balanced answer is not retried (the retry is for the safety filter only)', async () => {
  replies = [[finish('length')]];
  const { error } = await ask(publikSettings({ smart: true }));
  assert.equal(error.message, LENGTH_EMPTY_MESSAGE);
  assert.equal(requests.length, 1);
});

// ---- Anthropic path: stop_reason ---------------------------------------------

const anthropicSettings = () => publikSettings({ provider: 'anthropic', models: { anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-haiku-4-5-20251001' } } });
const aDelta = (t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const aStop = (reason) => ({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } });

test('Anthropic: stop_reason "refusal" after a partial answer adds the safety-filter note', async () => {
  anthropicEvents = [{ type: 'message_start' }, aDelta('Here is part'), aStop('refusal'), { type: 'message_stop' }];
  const { result } = await ask(anthropicSettings());
  assert.equal(result, 'Here is part' + FILTER_NOTE);
});

test('Anthropic: stop_reason "max_tokens" keeps the length behavior', async () => {
  anthropicEvents = [aDelta('Long'), aStop('max_tokens')];
  assert.equal((await ask(anthropicSettings())).result, 'Long' + LENGTH_CUT_NOTE);
  anthropicEvents = [aStop('max_tokens')];
  assert.equal((await ask(anthropicSettings())).error.message, LENGTH_EMPTY_MESSAGE);
});

test('Anthropic: "end_turn" is a whole answer; no stop_reason at all is incomplete', async () => {
  anthropicEvents = [aDelta('Done.'), aStop('end_turn')];
  assert.equal((await ask(anthropicSettings())).result, 'Done.');
  anthropicEvents = [aDelta('Done?')];
  assert.equal((await ask(anthropicSettings())).result, 'Done?' + INCOMPLETE_NOTE);
});

// ---- Gemini path: finishReason -------------------------------------------------

const geminiSettings = () => publikSettings({ provider: 'gemini' });
const gChunk = (t, reason) => ({ text: t, candidates: [{ content: { parts: t ? [{ text: t }] : [] }, ...(reason ? { finishReason: reason } : {}) }] });

test('Gemini: SAFETY with no text gives the safety-filter message, not a blank answer', async () => {
  geminiChunks = [gChunk(undefined, 'SAFETY')];
  const { error } = await ask(geminiSettings());
  assert.equal(error.message, FILTER_EMPTY);
});

test('Gemini: a blocked prompt (promptFeedback.blockReason, no candidate) gives the safety-filter message', async () => {
  geminiChunks = [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }];
  const { error } = await ask(geminiSettings());
  assert.equal(error.message, FILTER_EMPTY);
});

test('Gemini: MAX_TOKENS keeps the length behavior', async () => {
  geminiChunks = [gChunk('Long'), gChunk('er', 'MAX_TOKENS')];
  assert.equal((await ask(geminiSettings())).result, 'Longer' + LENGTH_CUT_NOTE);
});

test('Gemini: RECITATION says the answer repeated published text', async () => {
  geminiChunks = [gChunk('Quoted', 'RECITATION')];
  assert.equal((await ask(geminiSettings())).result, 'Quoted' + RECITATION_NOTE);
  geminiChunks = [gChunk(undefined, 'RECITATION')];
  assert.equal((await ask(geminiSettings())).error.message, RECITATION_EMPTY);
});

test('Gemini: STOP is a whole answer', async () => {
  geminiChunks = [gChunk('All '), gChunk('done.', 'STOP')];
  assert.equal((await ask(geminiSettings())).result, 'All done.');
});

// ---- slide captions and meeting notes (lengthCut 'ellipsis') ------------------

test('slide caption: a refused partial caption keeps its text, ends with "…", and never carries the refusal', async () => {
  replies = [[text('Slide 3: capillary action in a '), text(REFUSAL), finish('content_filter')]];
  const { result, shown } = await ask(publikSettings(), { imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis', onToken: () => {} });
  assert.equal(result, 'Slide 3: capillary action in a…');
  assert.equal(shown, '');
});

test('slide caption: a refusal-only caption fails (no caption is stored), after one retry on a linked install', async () => {
  replies = [[text(REFUSAL), finish('content_filter')], [text(REFUSAL), finish('content_filter')]];
  const { error } = await ask(publikSettings(), { imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis' });
  assert.equal(error.message, FILTER_EMPTY);
  assert.equal(requests.length, 2);
});

function notesHarness(settings) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-cf-'));
  const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
  const memory = createMeetingMemory({ store, llmFactory: () => createLLM(settings), now: () => 1_000_010, log: () => {}, minTurnsForNotes: 2 });
  memory.onTurn({ channel: 'them', text: 'The wick draws the melted wax up.', ts: 1_000_001 });
  memory.onTurn({ channel: 'you', text: 'Then the vapour burns.', ts: 1_000_002 });
  return { store, memory, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('meeting notes: a refusal-only answer stores no notes and no refusal title', async () => {
  replies = [[text(REFUSAL), finish('content_filter')]];
  const { store, memory, cleanup } = notesHarness(publikSettings({ smart: true, publik: anonymous, models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } } }));
  replies.push([finish('content_filter')]); // the one retry (publik-fast) is refused too
  try {
    const notes = await memory.refreshNotes();
    assert.equal(notes, null);
    const m = store.get(memory.current.id);
    assert.ok(!m.summary, 'no summary stored');
    assert.doesNotMatch(String(m.title || ''), /rejected|high risk/);
  } finally {
    cleanup();
  }
});

test('meeting notes: notes cut by the filter keep their text, end with "…", and never carry the refusal', async () => {
  replies = [[text('Meeting Summary:\nThe wick draws the melted wax up and the vap'), text(REFUSAL), finish('content_filter')]];
  const { store, memory, cleanup } = notesHarness(publikSettings());
  try {
    const notes = await memory.refreshNotes();
    assert.equal(notes.summary, 'The wick draws the melted wax up and the vap…');
    const m = store.get(memory.current.id);
    assert.doesNotMatch(JSON.stringify(m), /rejected|high risk/);
  } finally {
    cleanup();
  }
});

test('main.js logs the one retry (llm_filter_retry) and the stop kind of an empty answer', () => {
  const mainSrc = require('./source-text').readSource('main.js');
  assert.match(mainSrc, /onRetry: \(r\) => recordEvent\(\{ level: 'info', event: 'llm_filter_retry'/);
  assert.match(mainSrc, /stopKind: \(e && e\.stopKind\) \|\| null/);
});
