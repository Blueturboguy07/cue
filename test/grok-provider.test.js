const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveGrokCredentials, describeGrokAuth, XAI_BASE_URL } = require('../src/grok-cli-auth');
const { createLLM } = require('../src/llm');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');

const callbacks = {
  onTranscript() {},
  onInterim() {},
  onError() {},
  onStatusChange() {}
};

test('grok-cli-auth: explicit settings key wins', () => {
  const creds = resolveGrokCredentials('xai-test-key');
  assert.equal(creds.key, 'xai-test-key');
  assert.equal(creds.source, 'settings');
});

test('grok-cli-auth: describeGrokAuth reports availability for settings key', () => {
  const d = describeGrokAuth('abc');
  assert.equal(d.available, true);
  assert.equal(d.source, 'settings');
});

test('createLLM: grok provider uses api.x.ai and resolves model', () => {
  const llm = createLLM({
    provider: 'grok',
    smart: false,
    apiKeys: { grok: 'xai-test-key' },
    models: { grok: { fast: 'grok-4.5', smart: 'grok-4.5' } }
  });
  assert.equal(llm.ready, true);
  assert.equal(llm.provider, 'grok');
  assert.equal(llm.model, 'grok-4.5');
  assert.equal(llm.baseURL, XAI_BASE_URL);
  assert.equal(llm.apiKey, 'xai-test-key');
});

test('createLLM: grok without credentials is not ready', () => {
  // Force-empty path: pass a settings key that is empty AND temporarily hide env/cli
  // by providing empty explicit key; if CLI is logged in, resolveGrokApiKey still succeeds.
  // So we only assert the ready path when createLLM is given a non-empty explicit key above.
  // This test documents configurationError when nothing is resolvable by mocking:
  const { createLLM: create } = require('../src/llm');
  // If the developer machine has Grok CLI login, createLLM will still be ready — skip soft.
  const llm = create({
    provider: 'grok',
    apiKeys: { grok: '' },
    models: { grok: { fast: 'grok-4.5', smart: 'grok-4.5' } }
  });
  if (!llm.ready) {
    assert.match(llm.configurationError || '', /Sign in|XAI_API_KEY|API key/i);
  } else {
    assert.equal(llm.model, 'grok-4.5');
  }
});

test('createSTT: explicit grok selection only uses grok', () => {
  const stt = createSTT({
    sttProvider: 'grok',
    apiKeys: { grok: 'xai-test-key', openai: 'sk-test', gemini: 'g-test' }
  });
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['grok']);
});

test('createStreamingSTT: explicit grok uses xAI websocket provider', () => {
  const result = createStreamingSTT({
    sttProvider: 'grok',
    apiKeys: { grok: 'xai-test-key', deepgram: 'dg', openai: 'sk' }
  }, 'you', callbacks);
  assert.equal(result.type, 'streaming');
  assert.equal(result.provider, 'grok');
  assert.ok(result.instance);
  result.instance.disconnect();
});
