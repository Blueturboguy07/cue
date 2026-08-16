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
