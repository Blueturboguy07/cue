const assert = require('node:assert/strict');
const test = require('node:test');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');
const { CURRENT_GEMINI_DEFAULT } = require('../src/llm');

const callbacks = {
  onTranscript() {},
  onInterim() {},
  onError() {},
  onStatusChange() {}
};

test('explicit local mode never constructs a cloud fallback', () => {
  const settings = {
    sttProvider: 'local',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', deepgram: 'deepgram-key' }
  };
  assert.equal(createSTT(settings).available, false);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'local',
    instance: null
  });
});

test('explicit cloud selection does not cross-fallback to another provider', () => {
  const openai = createSTT({
    sttProvider: 'openai',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  const gemini = createSTT({
    sttProvider: 'gemini',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  assert.deepEqual(openai.providers, ['openai']);
  assert.deepEqual(gemini.providers, ['gemini']);
});

test('explicit Custom selection with a base URL and key is offered and usable for STT', () => {
  const settings = {
    sttProvider: 'custom',
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'test-custom-key' }
  };
  const batch = createSTT(settings);
  assert.equal(batch.available, true);
  assert.deepEqual(batch.providers, ['custom']);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'custom',
    instance: null
  });
});

test('explicit Custom selection without both a base URL and a key stays unavailable (no silent partial send)', () => {
  assert.equal(createSTT({ sttProvider: 'custom', apiKeys: { custom: 'test-custom-key' } }).available, false);
  assert.equal(createSTT({ sttProvider: 'custom', baseUrl: 'http://127.0.0.1:18789/v1', apiKeys: {} }).available, false);
});

test('auto mode still never reaches for the Custom chat key for STT (unchanged from before)', () => {
  const speechToText = createSTT({
    sttProvider: 'auto',
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' }
  });
  assert.equal(speechToText.available, false);
  assert.deepEqual(speechToText.providers, []);
});

// Regression for issue #25: Settings held a working Gemini model, but the STT
// path ignored settings.models entirely and hardcoded its own id — so
// transcription 404'd against a model the user had never selected, and the
// error text named that unfamiliar id back at them.
test('Gemini STT transcribes with the model configured in Settings', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.6-flash' } }
  });
  assert.deepEqual(stt.models, ['gemini-3.5-flash-lite']);
});

test('Gemini STT honours the smart tier the same way the chat path does', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    smart: true,
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.6-flash' } }
  });
  assert.deepEqual(stt.models, ['gemini-3.6-flash']);
});

test('Gemini STT migrates a retired model saved on disk instead of 404ing forever', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  });
  assert.deepEqual(stt.models, [CURRENT_GEMINI_DEFAULT]);
});

test('explicit Groq selection transcribes with Groq only, beside any chat provider', () => {
  // e.g. chat on a Custom router (TokenRouter) + speech on Groq; an OpenAI key
  // present for something else must not pull audio onto OpenAI Realtime.
  const settings = {
    provider: 'custom',
    sttProvider: 'groq',
    baseUrl: 'https://router.example/v1',
    apiKeys: { custom: 'router-key', groq: 'gsk_test', openai: 'openai-key' }
  };
  assert.deepEqual(createSTT(settings).providers, ['groq']);
  assert.equal(createStreamingSTT(settings, 'you', callbacks).type, 'batch');
});

test('Settings lets chat and speech-to-text use different providers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(html, /<button data-stt-provider="groq">/);
  // The STT provider's key field must be visible even when chat is on another provider.
  assert.match(renderer, /el\.dataset\.keyFor !== provider && el\.dataset\.keyFor !== sttProvider/);
  // A Groq STT key must not switch chat away from a keyless Custom endpoint.
  assert.match(renderer, /!\['custom', 'ollama'\]\.includes\(settings\.provider\)/);
});
