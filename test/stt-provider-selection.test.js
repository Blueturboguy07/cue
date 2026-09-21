const assert = require('node:assert/strict');
const test = require('node:test');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');

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
