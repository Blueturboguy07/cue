// Content filter, round 2 (blind verify of 3282584, 2026-11-05).
// D1: a normal answer that ENDED with a listed phrase (matched in any case)
//     was cut and labelled "safety filter"; an answer that was only "Content
//     Exists Risk" lower-cased was dropped and asked again on paid
//     publik-smart. Now a clean stop is a whole answer unless the WHOLE answer
//     is an exact provider message (case-sensitive).
// D2: under content_filter, wording variants were left on screen ("high-risk",
//     "(request id: ...)", a double space, more words, the message twice).
// D3: a missing or unknown stop reason put "(Incomplete: ...)" on every answer
//     of own-key servers that say "eos_token", "eos", ... or nothing.
// D4: retries from slide captions and meeting notes were not logged.
// Effort: cue sent no reasoning effort, so publik-balanced (screenshot
//     questions on the fast tier) ran at the gateway's "medium" and could think
//     until the cap with no answer. A live A/B showed MiMo thinks as much at
//     "low"; only "none" turns it off. Now assist and ask send "none" on the
//     fast tier, everything else there "low"; Smart never turns thinking off.
// Every test here fails on 3282584 unless it says "guard".
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

let requests = [];
let replies = [];
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
const { createLLM, refusalFilter, stopKind } = llmModule;
const { createMeetingStore } = require('../src/meetings');
const { createMeetingMemory } = require('../src/meeting-memory');

const FILTER_EMPTY = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const FILTER_NOTE = "\n\n(Incomplete: the AI provider's safety filter stopped this answer. Ask again with different words to get the rest.)";
const INCOMPLETE_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';
const MIMO = 'The request was rejected because it was considered high risk';
const ZHIPU = '系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。';

const PUBLIK_KEY = 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345';
function publikSettings(overrides = {}) {
  return {
    provider: 'publik', smart: false,
    apiKeys: { publik: PUBLIK_KEY, openai: 'sk-own', custom: 'sk-custom', anthropic: 'sk-ant-own', gemini: 'g-own', azure: 'az-own' },
    publik: { baseUrl: '', claimState: 'claimed' },
    baseUrl: 'http://127.0.0.1:1/v1',
    azureEndpoint: 'https://cue-test.cognitiveservices.azure.com',
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' }, openai: { fast: 'gpt-own', smart: 'gpt-own' }, custom: { fast: 'my-local', smart: 'my-local' } },
    ...overrides
  };
}
const anonymous = { baseUrl: '', claimState: 'anonymous' };
function text(t) { return { choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }; }
function finish(reason) { return { choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 900, completion_tokens: 40 } }; }
const IMAGE = 'data:image/jpeg;base64,AAAA';

async function ask(settings, params = {}) {
  const tokens = [];
  const retries = [];
  let result;
  let error = null;
  try {
    result = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: (t) => tokens.push(t), onRetry: (r) => retries.push(r), ...params });
  } catch (e) {
    error = e;
  }
  return { result, error, shown: tokens.join(''), tokens, retries };
}
const balanced = () => publikSettings({ smart: true }); // publik-balanced, linked: a refusal would be asked again on publik-smart

test.beforeEach(() => { requests = []; replies = []; anthropicEvents = []; geminiChunks = []; });

// ---- D1: a clean stop is a whole answer ---------------------------------------

test('D1: a normal answer that ends with a listed phrase (other case) is shown whole, no note, no retry', async () => {
  const answer = 'Say this: before the demo, warn users that the output data may contain inappropriate content.';
  replies = [[text('Say this: before the demo, '), text('warn users that the output data may contain inappropriate content.'), finish('stop')]];
  const { result, shown, error, retries } = await ask(balanced());
  assert.equal(error, null);
  assert.equal(result, answer);
  assert.equal(shown, answer);
  assert.equal(requests.length, 1);
  assert.deepEqual(retries, []);
});

test('D1: an answer that is only the phrase in another case is shown, never asked again on publik-smart', async () => {
  replies = [[text('content exists risk'), finish('stop')]];
  const { result, error } = await ask(balanced());
  assert.equal(error, null);
  assert.equal(result, 'content exists risk');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced']);
});

test('D1: a list that ends with the exact phrase, and an answer that ends with a quoted message, stay whole', async () => {
  replies = [[text('Risks:\n- Content Exists Risk'), finish('stop')]];
  assert.equal((await ask(balanced())).result, 'Risks:\n- Content Exists Risk');
  const quote = 'The log line reads: "' + MIMO + '."';
  replies = [[text(quote.slice(0, 25)), text(quote.slice(25)), finish('stop')]];
  assert.equal((await ask(balanced())).result, quote);
  replies = [[text('Add a banner: Input data may contain inappropriate content'), finish('stop')]];
  assert.equal((await ask(balanced())).result, 'Add a banner: Input data may contain inappropriate content');
  assert.equal(requests.length, 3, 'no retry');
});

test('D1 guard: the exact message as the whole answer with "stop" is still a refusal (one retry)', async () => {
  replies = [[text(MIMO + '.'), finish('stop')], [text('Smart answer.'), finish('stop')]];
  const { result } = await ask(balanced());
  assert.equal(result, 'Smart answer.');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-smart']);
});

test('D1/edge: a Chinese answer that quotes the Zhipu notice keeps all its text with "stop"', async () => {
  const answer = '日志显示：系统检测到输入或生成内容可能包含不安全或敏感内容。所以请求被拦截了，请修改提示词。';
  replies = [[text(answer.slice(0, 8)), text(answer.slice(8)), finish('stop')]];
  const { result, shown } = await ask(balanced());
  assert.equal(result, answer);
  assert.equal(shown, answer);
  replies = [[text(ZHIPU), finish('stop')], [finish('content_filter')]];
  assert.equal((await ask(publikSettings({ smart: true }))).error.message, FILTER_EMPTY, 'guard: the notice alone is a refusal');
});

// ---- D2: under content_filter, the provider's message goes, whatever its wording

test('D2: "high-risk", a request id, a double space: dropped under content_filter, then one retry', async () => {
  for (const variant of [
    'The request was rejected because it was considered high-risk',
    MIMO + ' (request id: gen-1762300000-AbC)',
    MIMO + '. Request ID: req_abc123',
    'The request was rejected because it was  considered high risk',
    'The request  was rejected\nbecause it was considered high risk'
  ]) {
    requests = [];
    replies = [[text(variant.slice(0, 11)), text(variant.slice(11)), finish('content_filter')], [text('Smart answer.'), finish('stop')]];
    const { result, shown } = await ask(balanced());
    assert.equal(result, 'Smart answer.', variant);
    assert.equal(shown, 'Smart answer.', variant);
    assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-smart'], variant);
  }
});

test('D2: extra words after the message, and the message twice, are dropped after a partial answer', async () => {
  replies = [[text('Partial answer. '), text(MIMO), text(', please modify your input and try again.'), finish('content_filter')]];
  assert.equal((await ask(balanced())).result, 'Partial answer. ' + FILTER_NOTE);
  replies = [[text('Partial answer. '), text(MIMO + ' ' + MIMO), finish('content_filter')]];
  const twice = await ask(balanced());
  assert.equal(twice.result, 'Partial answer. ' + FILTER_NOTE);
  assert.doesNotMatch(twice.shown, /rejected/);
});

test('D2 guard: the same variants with "stop" (and not the whole answer) are shown as sent', async () => {
  const answer = 'Partial answer. ' + MIMO + ', please modify your input and try again.';
  replies = [[text(answer), finish('stop')]];
  assert.equal((await ask(balanced())).result, answer);
});

test('D2 guard: a message start far from the end (more than a short notice) is content, even under content_filter', async () => {
  const answer = 'The gateway said "' + MIMO + '". ' + 'Then the answer goes on for a long time. '.repeat(8);
  replies = [[text(answer), finish('content_filter')]];
  assert.equal((await ask(balanced())).result, answer + FILTER_NOTE);
});

test('D2: text before a refusal start streams at once; only the start onward waits for the stop reason', () => {
  const f = refusalFilter();
  assert.equal(f.push('Sort the list, then '), 'Sort the list, then ');
  assert.equal(f.push('walk it. The request was rej'), 'walk it. ');
  assert.equal(f.push('ected because it was considered high-risk'), '');
  assert.equal(f.end('filter'), '');
  assert.equal(f.refused, true);
  const g = refusalFilter();
  assert.equal(g.push('The request was approved. '), 'The request was approved. ');
  assert.equal(g.push('Content'), '');
  assert.equal(g.push(' Exists Rules apply.'), 'Content Exists Rules apply.');
  assert.equal(g.end('clean'), '');
});

// ---- D3: no stop reason, or an end-of-turn word other than "stop" ------------

const custom = () => publikSettings({ provider: 'custom' }); // own key, OpenAI-compatible server

test('D3: own OpenAI-compatible servers: end-of-turn words other than "stop" are whole answers', async () => {
  for (const reason of ['eos_token', 'eos', 'end_turn', 'stop_sequence', 'end_of_turn', 'EOS']) {
    replies = [[text('Whole answer.'), finish(reason)]];
    const { result, shown } = await ask(custom());
    assert.equal(result, 'Whole answer.', reason);
    assert.equal(shown, 'Whole answer.', reason);
  }
});

test('D3: own OpenAI-compatible server with no finish reason: whole (no evidence it was cut)', async () => {
  replies = [[text('An answer from a server that sends no finish reason.')]];
  assert.equal((await ask(custom())).result, 'An answer from a server that sends no finish reason.');
  replies = [[text('Azure answer.')]];
  assert.equal((await ask(publikSettings({ provider: 'azure', models: { azure: { fast: 'gpt-own', smart: 'gpt-own' } } }))).result, 'Azure answer.');
});

test('D3 guard: real non-normal reasons stay incomplete; length stays length', async () => {
  for (const reason of ['error', 'abort', 'OTHER']) {
    replies = [[text('Half'), finish(reason)]];
    assert.equal((await ask(custom())).result, 'Half' + INCOMPLETE_NOTE, reason);
  }
  assert.equal(stopKind('max_length'), 'length');
});

test('D3: stopKind: no reason is clean unless the stream shows it was cut short', () => {
  assert.equal(stopKind('', false), 'clean');
  assert.equal(stopKind(null, false), 'clean');
  assert.equal(stopKind('FINISH_REASON_UNSPECIFIED', false), 'clean');
  assert.equal(stopKind('', false, { cutShort: true }), 'incomplete');
  assert.equal(stopKind('stop', false, { cutShort: true }), 'clean', 'a stop reason wins');
});

test('D3 guard: a cancelled stream (cue gave up) with no reason is incomplete', async () => {
  const controller = new AbortController();
  controller.abort();
  replies = [[text('Started to')]];
  const { result } = await ask(custom(), { signal: controller.signal });
  assert.equal(result, 'Started to' + INCOMPLETE_NOTE);
});

const anthropicSettings = () => publikSettings({ provider: 'anthropic', models: { anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-haiku-4-5-20251001' } } });
const aDelta = (t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

test('D3: Anthropic: no stop_reason but message_stop came: whole; neither: incomplete', async () => {
  anthropicEvents = [{ type: 'message_start' }, aDelta('Done.'), { type: 'message_stop' }];
  assert.equal((await ask(anthropicSettings())).result, 'Done.');
  anthropicEvents = [{ type: 'message_start' }, aDelta('Done?')];
  assert.equal((await ask(anthropicSettings())).result, 'Done?' + INCOMPLETE_NOTE);
});

const geminiSettings = () => publikSettings({ provider: 'gemini' });
const gChunk = (t, reason) => ({ text: t, candidates: [{ content: { parts: t ? [{ text: t }] : [] }, ...(reason ? { finishReason: reason } : {}) }] });

test('D3: Gemini: no finishReason (or FINISH_REASON_UNSPECIFIED) is a whole answer', async () => {
  geminiChunks = [gChunk('All '), gChunk('done.')];
  assert.equal((await ask(geminiSettings())).result, 'All done.');
  geminiChunks = [gChunk('All '), gChunk('done.', 'FINISH_REASON_UNSPECIFIED')];
  assert.equal((await ask(geminiSettings())).result, 'All done.');
});

// ---- D4: retries from slide captions and meeting notes are logged ------------

test('D4: meeting notes: the one retry reaches the onRetry hook', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-cf2-'));
  const retries = [];
  try {
    const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
    const memory = createMeetingMemory({ store, llmFactory: () => createLLM(publikSettings({ smart: true })), now: () => 1_000_010, log: () => {}, minTurnsForNotes: 2, onRetry: (r) => retries.push(r) });
    memory.onTurn({ channel: 'them', text: 'The wick draws the melted wax up.', ts: 1_000_001 });
    memory.onTurn({ channel: 'you', text: 'Then the vapour burns.', ts: 1_000_002 });
    replies = [[text(MIMO), finish('content_filter')], [text('Meeting summary:\nWax and wick.'), finish('stop')]];
    const notes = await memory.refreshNotes();
    assert.ok(notes && notes.summary);
    assert.deepEqual(retries, [{ from: 'publik-balanced', to: 'publik-smart', finishReason: 'content_filter' }]);
    // A summary needs no deep thought: "low" even in Smart mode.
    assert.deepEqual(requests.map((r) => r.reasoning_effort), ['low', 'low']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D4: main.js logs caption and meeting-notes retries as llm_filter_retry', () => {
  const { readSource, fnFrom } = require('./source-text');
  const mainSrc = readSource('main.js');
  const caption = fnFrom(mainSrc, 'async function captionSlide');
  assert.match(caption, /onRetry: \(r\) => recordEvent\(\{ level: 'info', event: 'llm_filter_retry'[^\n]*frame: 'captionSlide', context: \{ mode: 'caption'/);
  assert.match(caption, /reasoningEffort: 'low'/);
  assert.match(mainSrc, /llmFactory: \(\) => createLLM\(store\.getSettings\(\)\),[\s\S]{0,200}onRetry: \(r\) => recordEvent\(\{ level: 'info', event: 'llm_filter_retry'[^\n]*frame: 'meetingNotes', context: \{ mode: 'notes'/);
});

// ---- reasoning effort ----------------------------------------------------------

test('effort: a screenshot question on the fast tier asks publik-balanced for "low"', async () => {
  replies = [[text('Revenue is $4.2M.'), finish('stop')]];
  await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(requests[0].model, 'publik-balanced');
  assert.equal(requests[0].reasoning_effort, 'low');
  replies = [[text('Hi.'), finish('stop')]];
  await ask(publikSettings());
  assert.equal(requests[1].model, 'publik-fast');
  assert.equal(requests[1].reasoning_effort, 'low');
});

test('effort: Smart mode keeps the gateway default (no reasoning_effort sent); a caller may still ask for "low"', async () => {
  await ask(publikSettings({ smart: true }), { imageDataUrl: IMAGE });
  assert.equal(requests[0].model, 'publik-balanced');
  assert.equal('reasoning_effort' in requests[0], false);
  await ask(publikSettings({ smart: true }), { imageDataUrl: IMAGE, reasoningEffort: 'low', maxTokens: 300, lengthCut: 'ellipsis' });
  assert.equal(requests[1].reasoning_effort, 'low');
});

test('effort: the one retry asks with the same effort', async () => {
  replies = [[text(MIMO), finish('content_filter')], [text('It is a slide.'), finish('stop')]];
  await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.deepEqual(requests.map((r) => [r.model, r.reasoning_effort]), [['publik-balanced', 'low'], ['publik-smart', 'low']]);
});

test('effort: assist and ask ask for "none" (answer at once); publik-balanced gets it on the fast tier', async () => {
  replies = [[text('May had the most.'), finish('stop')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE, reasoningEffort: 'none' });
  assert.equal(result, 'May had the most.');
  assert.deepEqual(requests.map((r) => [r.model, r.reasoning_effort]), [['publik-balanced', 'none']]);
});

test('effort guard: Smart mode never turns thinking off: "none" is dropped (gateway default)', async () => {
  await ask(publikSettings({ smart: true }), { imageDataUrl: IMAGE, reasoningEffort: 'none' });
  assert.equal(requests[0].model, 'publik-balanced');
  assert.equal('reasoning_effort' in requests[0], false);
});

test('effort: a model that refuses "none" with a 400 is asked once more at "low"', async () => {
  replies = [Object.assign(new Error('400 Reasoning is mandatory for this endpoint and cannot be disabled.'), { status: 400 }), [text('Answer at low.'), finish('stop')]];
  const { result, error } = await ask(publikSettings(), { imageDataUrl: IMAGE, reasoningEffort: 'none' });
  assert.equal(error, null);
  assert.equal(result, 'Answer at low.');
  assert.deepEqual(requests.map((r) => [r.model, r.reasoning_effort]), [['publik-balanced', 'none'], ['publik-balanced', 'low']]);
});

test('effort guard: a 400 to any other request is not asked again', async () => {
  replies = [Object.assign(new Error('400 image too large'), { status: 400 })];
  const { error } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.ok(error);
  assert.equal(requests.length, 1);
});

test('effort: the filter retry after "none" asks the other model at "low", never "none"', async () => {
  replies = [[text(MIMO), finish('content_filter')], [text('It is a slide.'), finish('stop')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE, reasoningEffort: 'none' });
  assert.equal(result, 'It is a slide.');
  assert.deepEqual(requests.map((r) => [r.model, r.reasoning_effort]), [['publik-balanced', 'none'], ['publik-smart', 'low']]);
});

test('effort: src/prompts.js: assist and ask answer at once, leetcode and the text modes think; main.js passes the mode\'s level', () => {
  const { MODES } = require('../src/prompts');
  assert.equal(MODES.assist.effort, 'none');
  assert.equal(MODES.ask.effort, 'none');
  for (const [name, def] of Object.entries(MODES)) {
    if (name !== 'assist' && name !== 'ask') assert.equal(def.effort, undefined, name);
  }
  const { readSource, fnFrom } = require('./source-text');
  const run = fnFrom(readSource('main.js'), 'async function runFeature');
  assert.match(run, /llm\.stream\(\{[\s\S]*reasoningEffort: def\.effort,/);
});

test('effort guard: own keys never get reasoning_effort, even when a caller asks for it', async () => {
  await ask(publikSettings({ provider: 'openai' }), { reasoningEffort: 'low' });
  await ask(custom(), { reasoningEffort: 'low' });
  assert.equal(requests.length, 2);
  for (const r of requests) assert.equal('reasoning_effort' in r, false);
});

test('effort guard: an unlinked install still gets its refused text question asked once on publik-fast', async () => {
  replies = [[text(MIMO), finish('content_filter')], [text('Fast answer.'), finish('stop')]];
  const { result } = await ask(publikSettings({ smart: true, publik: anonymous }));
  assert.equal(result, 'Fast answer.');
  assert.deepEqual(requests.map((r) => r.model), ['publik-balanced', 'publik-fast']);
});
