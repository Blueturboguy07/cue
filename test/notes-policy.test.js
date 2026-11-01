const assert = require('node:assert/strict');
const test = require('node:test');
const { notesDestination } = require('../src/notes-policy');

test('automatic notes require explicit opt-in, independently of speech selection', () => {
  for (const automaticNotes of [undefined, false, 'true', 1, null]) {
    assert.equal(notesDestination({ automaticNotes, provider: 'openai', sttProvider: 'local' }), null);
  }
  assert.ok(notesDestination({ automaticNotes: true, provider: 'openai', sttProvider: 'local' }));
});

test('every configurable recipient change invalidates the old notes destination', () => {
  for (const [provider, field] of [['custom', 'baseUrl'], ['azure', 'azureEndpoint'], ['anthropic', 'anthropicBaseUrl'], ['minimax', 'minimaxRegion']]) {
    const before = { automaticNotes: true, provider, [field]: 'first-endpoint' };
    assert.notEqual(notesDestination(before), notesDestination({ ...before, [field]: 'second-endpoint' }));
  }
  assert.notEqual(notesDestination({ automaticNotes: true, provider: 'ollama' }), notesDestination({ automaticNotes: true, provider: 'ollama', apiKeys: { ollama: 'https://other.invalid' } }));
  assert.notEqual(notesDestination({ automaticNotes: true, provider: 'publik' }), notesDestination({ automaticNotes: true, provider: 'publik', publik: { baseUrl: 'https://other.invalid' } }));
});

test('stored destination fingerprints exclude endpoint credentials and query strings', () => {
  const destination = notesDestination({ automaticNotes: true, provider: 'custom', baseUrl: 'https://user:synthetic-secret@example.invalid/v1?key=synthetic-secret' });
  assert.doesNotMatch(destination, /synthetic-secret|user|example/);
});
