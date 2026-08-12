const assert = require('node:assert/strict');
const test = require('node:test');
const { createLLM } = require('../src/llm');
const { isCliProvider, cliProviderReady, whichCmd } = require('../src/cli-llm');

test('isCliProvider recognizes Claude / Codex / Grok CLI ids', () => {
  assert.equal(isCliProvider('claude-cli'), true);
  assert.equal(isCliProvider('codex-cli'), true);
  assert.equal(isCliProvider('grok-cli'), true);
  assert.equal(isCliProvider('anthropic'), false);
  assert.equal(isCliProvider('grok'), false);
});

test('createLLM: CLI providers are ready without API keys', () => {
  for (const provider of ['claude-cli', 'codex-cli', 'grok-cli']) {
    const llm = createLLM({
      provider,
      apiKeys: {},
      models: { [provider]: { fast: 'default', smart: 'default' } }
    });
    // ready depends on binary presence; configurationError must not demand an API key
    if (!llm.ready) {
      assert.match(llm.configurationError || '', /CLI not found|PATH/i);
    } else {
      assert.equal(llm.configurationError, '');
    }
  }
});

test('createLLM: Claude CLI does not require anthropic key', () => {
  const llm = createLLM({
    provider: 'claude-cli',
    apiKeys: { anthropic: '' },
    models: { 'claude-cli': { fast: 'default', smart: 'default' } }
  });
  assert.ok(!/API key/i.test(llm.configurationError || ''));
});

test('createLLM: Codex CLI does not require openai key', () => {
  const llm = createLLM({
    provider: 'codex-cli',
    apiKeys: { openai: '' },
    models: { 'codex-cli': { fast: 'default', smart: 'default' } }
  });
  assert.ok(!/API key/i.test(llm.configurationError || ''));
});

test('whichCmd returns a string for known CLIs', () => {
  assert.equal(typeof whichCmd('codex'), 'string');
  assert.equal(typeof whichCmd('claude'), 'string');
  assert.equal(typeof whichCmd('grok'), 'string');
});

test('cliProviderReady shape', () => {
  const r = cliProviderReady('codex-cli');
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) assert.ok(r.bin);
  else assert.ok(r.error);
});
