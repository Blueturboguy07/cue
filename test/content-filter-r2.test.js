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
// Effort (round 3, blind verify of 992973d): "none" for assist and ask got
//     multi-step answers wrong on publik-balanced (9 of 16 right against 15 of
//     15), and "low" thinks as much as "medium" there. So every mode sends
//     exactly what 0.2.12 (fbd52fe) sent: no reasoning_effort at all.
// Length (round 3): a "length" stop keeps its text and gets the length note;
//     legit words like "The request was rejected because the token
//     expired" at its end are never cut, labelled or asked again.
// Every test here fails on 3282584 unless it says "guard". The effort and
// length tests also fail on 992973d.
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
    // As 0.2.12: no reasoning_effort, on the first try or the retry.
    assert.deepEqual(requests.map((r) => 'reasoning_effort' in r), [false, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D4: main.js logs caption and meeting-notes retries as llm_filter_retry', () => {
  const { readSource, fnFrom } = require('./source-text');
  const mainSrc = readSource('main.js');
  const caption = fnFrom(mainSrc, 'async function captionSlide');
  assert.match(caption, /onRetry: \(r\) => recordEvent\(\{ level: 'info', event: 'llm_filter_retry'[^\n]*frame: 'captionSlide', context: \{ mode: 'caption'/);
  assert.doesNotMatch(caption, /reasoningEffort/);
  assert.match(mainSrc, /llmFactory: \(\) => createLLM\(store\.getSettings\(\)\),[\s\S]{0,200}onRetry: \(r\) => recordEvent\(\{ level: 'info', event: 'llm_filter_retry'[^\n]*frame: 'meetingNotes', context: \{ mode: 'notes'/);
});

// ---- reasoning effort: exactly what 0.2.12 sent -------------------------------

// fbd52fe's OpenAI-compatible request body, for every provider and mode.
const FBD52FE_BODY_KEYS = ['max_tokens', 'messages', 'model', 'stream'];
const bodyKeys = (r) => Object.keys(r).sort();

test('effort: assist and ask (a screenshot question on the fast tier) send no reasoning_effort, as 0.2.12', async () => {
  replies = [[text('Revenue is $4.2M.'), finish('stop')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(result, 'Revenue is $4.2M.');
  assert.equal(requests[0].model, 'publik-balanced');
  assert.equal('reasoning_effort' in requests[0], false);
  assert.deepEqual(bodyKeys(requests[0]), FBD52FE_BODY_KEYS);
});

test('effort: every mode\'s request body matches 0.2.12 (fbd52fe) on the effort field, fast and Smart', async () => {
  const { MODES } = require('../src/prompts');
  // The params each call site passes (main.js runFeature / captionSlide,
  // src/meeting-memory.js), plus a stale caller that still asks for a level.
  const calls = [
    ...Object.entries(MODES).map(([name, def]) => [name, def.needsScreen ? { imageDataUrl: IMAGE } : {}]),
    ['caption', { imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis' }],
    ['notes', { maxTokens: 600, lengthCut: 'ellipsis' }],
    ['stale caller "none"', { imageDataUrl: IMAGE, reasoningEffort: 'none' }],
    ['stale caller "low"', { reasoningEffort: 'low' }]
  ];
  assert.ok(calls.length >= 8, 'every mode in src/prompts.js is covered');
  for (const smart of [false, true]) {
    for (const [name, params] of calls) {
      requests = [];
      replies = [[text('ok'), finish('stop')]];
      await ask(publikSettings({ smart }), params);
      assert.equal(requests.length, 1, name);
      assert.deepEqual(bodyKeys(requests[0]), FBD52FE_BODY_KEYS, `${smart ? 'Smart' : 'fast'} ${name}`);
    }
  }
});

test('effort: the one filter retry sends no reasoning_effort either', async () => {
  replies = [[text(MIMO), finish('content_filter')], [text('It is a slide.'), finish('stop')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(result, 'It is a slide.');
  assert.deepEqual(requests.map((r) => [r.model, 'reasoning_effort' in r]), [['publik-balanced', false], ['publik-smart', false]]);
});

test('effort: call sites as 0.2.12: no mode carries an effort, main.js and meeting notes pass none, llm.js never writes one', () => {
  const { MODES } = require('../src/prompts');
  for (const [name, def] of Object.entries(MODES)) assert.equal('effort' in def, false, name);
  const { readSource, fnFrom } = require('./source-text');
  const mainSrc = readSource('main.js');
  assert.doesNotMatch(fnFrom(mainSrc, 'async function runFeature'), /reasoningEffort|reasoning_effort/);
  assert.doesNotMatch(fnFrom(mainSrc, 'async function captionSlide'), /reasoningEffort|reasoning_effort/);
  assert.doesNotMatch(readSource('src/meeting-memory.js'), /reasoningEffort|reasoning_effort/);
  assert.doesNotMatch(readSource('src/llm.js'), /reasoningEffort|\.reasoning_effort\s*=|reasoning_effort:/);
});

test('guard: a 400 is never asked again', async () => {
  replies = [Object.assign(new Error('400 image too large'), { status: 400 })];
  const { error } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.ok(error);
  assert.equal(requests.length, 1);
});

// ---- a length stop keeps its text (round 3) -----------------------------------

const LENGTH_CUT_NOTE = '\n\n(Cut off: the answer reached its length limit.)';
const TOKEN_EXPIRED = 'The request was rejected because the token expired, so refresh it before the next call and';

test('length: legit "The request was rejected because ..." at the end of a length cut keeps its text and gets the length note', async () => {
  const answer = 'Step 1: read the proxy log. It says: ' + TOKEN_EXPIRED;
  replies = [[text('Step 1: read the proxy log. It says: '), text(TOKEN_EXPIRED), finish('length')]];
  const { result, shown, error } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(error, null);
  assert.equal(result, answer + LENGTH_CUT_NOTE);
  assert.equal(shown, result);
  assert.equal(requests.length, 1);
});

test('length: an answer that starts with the phrase keeps all its text, with no paid retry', async () => {
  for (const words of [TOKEN_EXPIRED, MIMO]) {
    requests = [];
    replies = [[text(words), finish('length')]];
    const { result, retries } = await ask(publikSettings(), { imageDataUrl: IMAGE });
    assert.equal(result, words + LENGTH_CUT_NOTE, words);
    assert.deepEqual(retries, []);
    assert.equal(requests.length, 1);
  }
});

test('length: slide captions and notes (ellipsis cut) keep the phrase too', async () => {
  replies = [[text('Slide 3 covers why ' + TOKEN_EXPIRED), finish('length')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis' });
  assert.match(result, /^Slide 3 covers why The request was rejected because the token expired/);
  assert.match(result, /…$/);
});

test('length: other stops that are not a filter (error, cut short) keep their text too, with the Incomplete note', async () => {
  replies = [[text('It says: ' + TOKEN_EXPIRED), finish('error')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(result, 'It says: ' + TOKEN_EXPIRED + INCOMPLETE_NOTE);
});

test('length guard: the same words under a real filter stop are still cut off, with the safety note', async () => {
  replies = [[text('Step 1: read the proxy log. '), text(TOKEN_EXPIRED), finish('content_filter')]];
  const { result } = await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(result, 'Step 1: read the proxy log. ' + FILTER_NOTE);
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
