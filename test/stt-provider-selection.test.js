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

test('nvidia STT requires both an API key and a function-id', () => {
  const missingFunctionId = createSTT({
    sttProvider: 'nvidia',
    apiKeys: { nvidia: 'nvidia-key' }
  });
  assert.equal(missingFunctionId.available, false);

  const configured = createSTT({
    sttProvider: 'nvidia',
    apiKeys: { nvidia: 'nvidia-key' },
    nvidiaFunctionId: 'test-function-id'
  });
  assert.deepEqual(configured.providers, ['nvidia']);
});

test('explicit nvidia selection does not cross-fallback to another provider', () => {
  const nvidia = createSTT({
    sttProvider: 'nvidia',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', nvidia: 'nvidia-key' },
    nvidiaFunctionId: 'test-function-id'
  });
  assert.deepEqual(nvidia.providers, ['nvidia']);
});
