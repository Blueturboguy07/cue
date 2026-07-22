const assert = require('node:assert/strict');
const test = require('node:test');
const { MODES, formatTranscript } = require('../src/prompts');

test('formats transcript speakers and preserves chronological order', () => {
  const transcript = [
    { channel: 'you', text: 'Hello' },
    { channel: 'them', text: 'Hi there' },
    { channel: 'you', text: 'How are you?' }
  ];

  assert.equal(formatTranscript(transcript), 'You: Hello\nThem: Hi there\nYou: How are you?');
});

test('limits transcript formatting to the most recent turns', () => {
  const transcript = [
    { channel: 'them', text: 'Earlier' },
    { channel: 'you', text: 'Middle' },
    { channel: 'them', text: 'Latest' }
  ];

  assert.equal(formatTranscript(transcript, 2), 'You: Middle\nThem: Latest');
});

test('builds an ask prompt from user text and recent conversation', () => {
  const prompt = MODES.ask.build({
    transcript: [{ channel: 'them', text: 'Can you send that today?' }],
    userText: 'Draft a concise reply.'
  });

  assert.match(prompt, /Them: Can you send that today\?/);
  assert.match(prompt, /Question: Draft a concise reply\./);
});

test('builds an empty-state prompt when no conversation has been captured', () => {
  const prompt = MODES.say.build({ transcript: [] });

  assert.match(prompt, /nothing heard yet/);
});
