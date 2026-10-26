const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, currentThread } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('recap is grounded in the transcript and does not presume an interview', () => {
  const system = MODES.recap.buildSystem(null);
  assert.match(system, /actually said|only what is in the transcript/i, 'recap must be grounded in the transcript');
  assert.match(system, /generic/i, 'recap must forbid generic filler');
  // The only mention of interviews allowed is the conditional "if the context block says so".
  const unconditional = system.replace(/If the context block shows this is a job interview[^\n]*/g, '');
  assert.ok(!/\binterview/i.test(unconditional), 'recap must not assume the conversation is an interview');
  assert.equal(MODES.recap.transcriptRequired, true, 'recap needs a transcript to be meaningful');
  // Modes that also take a screenshot can run on an empty transcript.
  assert.ok(!MODES.assist.transcriptRequired);
  assert.ok(!MODES.ask.transcriptRequired);
  assert.ok(!MODES.leetcode.transcriptRequired);
});

test('recap user turn carries the real conversation', () => {
  const transcript = [
    { channel: 'them', text: 'We shipped the Terraform pipeline on Tuesday.', ts: 1 },
    { channel: 'you', text: 'How long did the deploy take?', ts: 2 }
  ];
  const turn = MODES.recap.build({ transcript, userText: '' });
  assert.match(turn, /Them: We shipped the Terraform pipeline on Tuesday\./);
  assert.match(turn, /You: How long did the deploy take\?/);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every non-leetcode mode injects AI rules into its system prompt', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every non-leetcode mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('leetcode mode never applies AI rules (coding answers stay strict)', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes('USER RULES'), 'leetcode must not include USER RULES');
  assert.ok(!withRules.includes(RULES), 'leetcode must not leak user rules into the prompt');
  assert.match(withRules, /competitive programmer/);
});
test('live-answer modes send only the current question thread', () => {
  const min = 60 * 1000;
  const transcript = [
    { channel: 'them', text: 'Old meeting question.', ts: 0 },
    { channel: 'them', text: 'Tell me about', ts: 20 * min },
    { channel: 'them', text: 'a hard bug.', ts: 20 * min + 900 },
    { channel: 'you', text: 'Sure, at my last job', ts: 21 * min },
    { channel: 'them', text: 'How did you find it?', ts: 22 * min }
  ];
  const thread = currentThread(transcript);
  assert.ok(!thread.includes('Old meeting'), 'turns older than the window are dropped');
  assert.match(thread, /^Them: Tell me about a hard bug\.\nYou: Sure, at my last job\nThem: How did you find it\?$/, 'fragments merge into utterances');
  const many = Array.from({ length: 20 }, (_, i) => ({ channel: i % 2 ? 'you' : 'them', text: `u${i}`, ts: i }));
  assert.equal(currentThread(many).split('\n').length, 8, 'capped to the last few utterances');
  for (const mode of ['say', 'assist']) {
    const text = MODES[mode].build({ transcript, userText: '' });
    assert.ok(!text.includes('Old meeting'), `${mode} must not resend stale turns`);
    assert.match(text, /newest question/);
  }
});

test('live-answer prompts frame the session as interview practice', () => {
  for (const mode of ['say', 'assist', 'ask', 'answerThis']) {
    const system = MODES[mode].buildSystem(null, '');
    assert.match(system, /practic/i, `${mode} should say this is practice`);
    assert.ok(!/whisper|discreet|live interview/i.test(system), `${mode} should not describe covert live use`);
  }
});
