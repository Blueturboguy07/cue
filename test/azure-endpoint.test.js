const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAzureBaseURL } = require('../src/llm');

test('normalizeAzureBaseURL reduces any pasted Azure path to the right base', () => {
  // Azure AI Foundry (services.ai / cognitiveservices) -> {origin}/openai/v1,
  // regardless of the trailing path the portal shows.
  assert.equal(
    normalizeAzureBaseURL('https://rhq.services.ai.azure.com/openai/v1/responses'),
    'https://rhq.services.ai.azure.com/openai/v1'
  );
  assert.equal(
    normalizeAzureBaseURL('https://rhq.services.ai.azure.com'),
    'https://rhq.services.ai.azure.com/openai/v1'
  );
  assert.equal(
    normalizeAzureBaseURL('https://h.cognitiveservices.azure.com/openai/v1/chat/completions'),
    'https://h.cognitiveservices.azure.com/openai/v1'
  );
  // Azure OpenAI resource -> bare origin (the SDK adds /openai/deployments/…).
  assert.equal(
    normalizeAzureBaseURL('https://res.openai.azure.com/openai/v1/responses'),
    'https://res.openai.azure.com'
  );
  assert.equal(normalizeAzureBaseURL('https://res.openai.azure.com/'), 'https://res.openai.azure.com');
  // Never doubles the suffix (the bug this replaces).
  assert.ok(!/openai\/v1\/.*openai\/v1/.test(normalizeAzureBaseURL('https://x.services.ai.azure.com/openai/v1/responses')));
  assert.equal(normalizeAzureBaseURL(''), '');
});
