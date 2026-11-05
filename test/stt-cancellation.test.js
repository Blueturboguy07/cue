const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { deferred } = require('./helpers/main-harness');

let transport;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'openai') {
    return class {
      static toFile = async () => ({ name: 'synthetic.wav' });
      constructor({ baseURL }) { this.audio = { transcriptions: { create: (_body, options) => transport({ baseURL, signal: options.signal }) } }; }
    };
  }
  if (request === '@google/genai') {
    return { GoogleGenAI: class { constructor() { this.models = { generateContent: (body) => transport({ model: body.model, signal: body.config.abortSignal }) }; } } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });
const { createSTT, transcribeGeminiWith } = require('../src/stt');

test('an already cancelled transcription sends no audio', async () => {
  let calls = 0;
  transport = async () => { calls++; return { text: 'synthetic' }; };
  const request = new AbortController(); request.abort();
  const stt = createSTT({ apiKeys: { openai: 'synthetic' } });
  await assert.rejects(stt.transcribe(Buffer.alloc(6400), { signal: request.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

for (const provider of ['openai', 'groq', 'custom', 'gemini']) {
  test(`${provider}: batch cancellation aborts the transport without awaiting a late response`, async () => {
    const entered = deferred(), result = deferred(), request = new AbortController();
    let signal;
    transport = (options) => { signal = options.signal; entered.resolve(); return result.promise; };
    const stt = createSTT({ sttProvider: provider, apiKeys: { [provider]: 'synthetic' }, baseUrl: 'https://synthetic.invalid/v1' });
    const pending = stt.transcribe(Buffer.alloc(6400), { signal: request.signal });
    await entered.promise;
    request.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(signal, request.signal);
    assert.equal(signal.aborted, true);
    result.resolve({ text: 'late words' });
  });
}

test('a cancelled Auto request never falls back to another stored-key recipient', async () => {
  const entered = deferred(), failure = deferred(), request = new AbortController();
  let calls = 0;
  transport = () => { calls++; entered.resolve(); return failure.promise; };
  const stt = createSTT({ sttProvider: 'auto', apiKeys: { openai: 'synthetic', groq: 'synthetic', gemini: 'synthetic' } });
  const pending = stt.transcribe(Buffer.alloc(6400), { signal: request.signal });
  await entered.promise;
  request.abort();
  failure.reject(Object.assign(new Error('unavailable'), { status: 401 }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a cancelled Gemini model failure never retries another model', async () => {
  const request = new AbortController(); let calls = 0;
  const ai = { models: { generateContent: async ({ config }) => {
    calls++;
    assert.equal(config.abortSignal, request.signal);
    request.abort();
    throw Object.assign(new Error('model unavailable'), { status: 404 });
  } } };
  await assert.rejects(transcribeGeminiWith(ai, Buffer.alloc(10), 9e15, request.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
