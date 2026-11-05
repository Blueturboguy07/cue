// Content filter, round 2, D3 on the wire: the real OpenAI SDK against a local
// SSE server. publik (OpenRouter behind it) always ends a stream with a
// finish reason and "data: [DONE]"; the SDK hides [DONE], so cue watches the
// bytes for it (src/llm.js doneWatcher). A publik stream with no finish
// reason is incomplete only when it closed before [DONE]; an own-key server
// that sends no finish reason is a whole answer. 3282584 put "(Incomplete:
// ...)" on all of them. Tests that pass on 3282584 too say "guard".
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const { createLLM } = require('../src/llm');

const INCOMPLETE_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';
const FILTER_EMPTY = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const MIMO = 'The request was rejected because it was considered high risk';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const chunk = (delta, finish) => ({ id: 'gen-x', provider: 'Xiaomi', model: 'xiaomi/mimo-v2.6-pro', object: 'chat.completion.chunk', created: 0, choices: [{ index: 0, delta, finish_reason: finish || null, native_finish_reason: finish || null }] });
const usage = { id: 'gen-x', object: 'chat.completion.chunk', created: 0, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

// frames: strings written one by one (a few ms apart); end: true = res.end().
async function withServer(frames, fn) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try { bodies.push(JSON.parse(raw || '{}')); } catch { bodies.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-publik-test': 'seen' });
      for (const f of frames) { res.write(f); await sleep(5); }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await fn(base, bodies);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const publikAt = (base, extra = {}) => ({
  provider: 'publik', smart: false,
  apiKeys: { publik: 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345' },
  publik: { baseUrl: base, claimState: 'claimed' },
  models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
  ...extra
});
const customAt = (base) => ({ provider: 'custom', smart: false, apiKeys: { custom: 'sk-local' }, baseUrl: base, models: { custom: { fast: 'my-local', smart: 'my-local' } } });

async function ask(settings, params = {}) {
  const tokens = [];
  let result;
  let error = null;
  try {
    result = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: (t) => tokens.push(t), ...params });
  } catch (e) {
    error = e;
  }
  return { result, error, shown: tokens.join(''), tokens };
}

test('publik: content, no finish reason, then [DONE]: a whole answer (no "Incomplete" note)', async () => {
  await withServer([sse(chunk({ content: 'A whole ' })), sse(chunk({ content: 'answer.' })), sse(usage), 'data: [DONE]\n\n'], async (base) => {
    const { result, shown } = await ask(publikAt(base));
    assert.equal(result, 'A whole answer.');
    assert.equal(shown, result);
  });
});

test('publik: [DONE] split across two network writes still counts', async () => {
  await withServer([sse(chunk({ content: 'Split done.' })), 'data: [DO', 'NE]\n\n'], async (base) => {
    assert.equal((await ask(publikAt(base))).result, 'Split done.');
  });
});

test('guard: publik stream that closes before [DONE] with no finish reason is incomplete and says so', async () => {
  await withServer([sse(chunk({ content: 'The wick draws the melted wax' }))], async (base) => {
    const { result, shown } = await ask(publikAt(base));
    assert.equal(result, 'The wick draws the melted wax' + INCOMPLETE_NOTE);
    assert.equal(shown, result);
  });
});

test('publik: "stop" + [DONE]: whole, streamed in pieces, the fast tier asks for reasoning_effort "low", headers still reach the hook', async () => {
  await withServer([sse(chunk({ reasoning: 'plan' })), sse(chunk({ content: 'One ' })), sse(chunk({ content: 'two.' })), sse(chunk({}, 'stop')), sse(usage), 'data: [DONE]\n\n'], async (base, bodies) => {
    let header = null;
    const { result, tokens } = await ask(publikAt(base), { onResponse: (res) => { header = res.headers.get('x-publik-test'); } });
    assert.equal(result, 'One two.');
    assert.ok(tokens.length >= 2, 'text streams in pieces');
    assert.equal(bodies[0].model, 'publik-fast');
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.equal(header, 'seen');
  });
});

test('own OpenAI-compatible server: no finish reason and no [DONE]: a whole answer', async () => {
  await withServer([sse({ choices: [{ index: 0, delta: { content: 'Local model answer.' } }] })], async (base, bodies) => {
    const { result } = await ask(customAt(base));
    assert.equal(result, 'Local model answer.');
    assert.equal('reasoning_effort' in bodies[0], false, 'no publik-only field to an own server');
  });
});

test('own OpenAI-compatible server: "eos_token" (TGI) is a whole answer', async () => {
  await withServer([sse({ choices: [{ index: 0, delta: { content: 'TGI answer.' }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'eos_token' }] }), 'data: [DONE]\n\n'], async (base) => {
    assert.equal((await ask(customAt(base))).result, 'TGI answer.');
  });
});

test('guard: the OpenRouter content_filter shape over the wire: refusal dropped, honest message, one retry asked', async () => {
  const frames = [sse(chunk({ role: 'assistant', content: '' })), sse(chunk({ reasoning: 'weighing' })), sse(chunk({ content: MIMO })), sse(chunk({ content: '' }, 'content_filter')), sse(usage), 'data: [DONE]\n\n'];
  await withServer(frames, async (base, bodies) => {
    const { error, shown } = await ask(publikAt(base, { smart: true, publik: { baseUrl: base, claimState: 'anonymous' } }), { imageDataUrl: 'data:image/jpeg;base64,AAAA' });
    assert.equal(error.message, FILTER_EMPTY);
    assert.equal(shown, '');
    assert.equal(bodies.length, 1, 'unlinked screenshot question: no retry');
  });
});

test('publik: a 400 to reasoning_effort "none" (model cannot turn thinking off) is asked once more at "low" over the wire', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      if (body.reasoning_effort === 'none') {
        // The publik gateway relays an upstream 4xx as 400 upstream_error.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', type: 'invalid_request_error', code: 'upstream_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(chunk({ content: 'Answer at low.' })) + sse(chunk({}, 'stop')) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const { result, error } = await ask(publikAt(base), { imageDataUrl: 'data:image/jpeg;base64,AAAA', reasoningEffort: 'none' });
    assert.equal(error, null);
    assert.equal(result, 'Answer at low.');
    assert.deepEqual(bodies.map((b) => [b.model, b.reasoning_effort]), [['publik-balanced', 'none'], ['publik-balanced', 'low']]);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
