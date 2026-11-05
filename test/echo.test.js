const test = require('node:test');
const assert = require('node:assert/strict');
const { isCrossTalkEcho } = require('../src/echo');

test('a sentence heard on the other channel moments later is an echo', () => {
  const transcript = [{ channel: 'them', text: 'What is the expected number of flips?', ts: 1000 }];
  assert.equal(isCrossTalkEcho({ channel: 'you', text: 'what is the expected number of flips', ts: 1800 }, transcript), true);
  assert.equal(isCrossTalkEcho({ channel: 'you', text: 'I would set up states for each streak.', ts: 1800 }, transcript), false, 'a real reply is kept');
  assert.equal(isCrossTalkEcho({ channel: 'you', text: 'what is the expected number of flips', ts: 9000 }, transcript), false, 'too late to be an echo');
  assert.equal(isCrossTalkEcho({ channel: 'them', text: 'What is the expected number of flips?', ts: 1800 }, transcript), false, 'same channel is a repeat, not an echo');
});
