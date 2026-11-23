const test = require('node:test');
const assert = require('node:assert/strict');
const { createEchoFilter } = require('../src/echo-filter');

function harness() {
  let t = 1_000_000;
  const timers = [];
  const published = [];
  const dropped = [];
  const filter = createEchoFilter({
    now: () => t,
    setTimeout: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    publish: (turn) => published.push(`${turn.channel}: ${turn.text}`),
    onDrop: (turn) => dropped.push(turn.text)
  });
  return {
    filter, published, dropped,
    at: (ms) => { t = 1_000_000 + ms; return t; },
    run: (ms) => {
      t += ms;
      for (const timer of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    }
  };
}

test('echo filter: the mic copy of the meeting audio is dropped, whichever arrives first (smoke test lines)', () => {
  const h = harness();
  // Same moment: the "you" copy came back before the "them" line.
  h.filter.offer({ channel: 'you', text: 'Walk me through a project where you used a large language', ts: h.at(3000) });
  h.filter.offer({ channel: 'them', text: 'Walk me through a project where you used a large language', ts: h.at(3100) });
  h.filter.offer({ channel: 'them', text: 'model and what trade-offs', ts: h.at(5000) });
  h.filter.offer({ channel: 'you', text: 'model and what trade-offs', ts: h.at(5050) });
  h.run(3000);
  assert.deepEqual(h.published, ['them: Walk me through a project where you used a large language', 'them: model and what trade-offs']);
  assert.equal(h.dropped.length, 2);
});

test('echo filter: the user answering in their own words is kept, after the short hold', () => {
  const h = harness();
  h.filter.offer({ channel: 'them', text: 'Can you walk me through a project where you used a large language model?', ts: h.at(0) });
  h.filter.offer({ channel: 'you', text: 'Sure, I built NeuroForge, a study assistant on Llama with ChromaDB retrieval.', ts: h.at(4000) });
  assert.deepEqual(h.published, ['them: Can you walk me through a project where you used a large language model?'], '"you" waits for a possible echo');
  h.run(2500);
  assert.equal(h.published.length, 2);
  assert.match(h.published[1], /^you: Sure, I built NeuroForge/);
  assert.deepEqual(h.dropped, []);
});

test('echo filter: a short "Yes." is dropped only when the other side just said it, and kept long after', () => {
  const h = harness();
  h.filter.offer({ channel: 'them', text: 'Yes, that works for us.', ts: h.at(0) });
  h.filter.offer({ channel: 'you', text: 'Yes.', ts: h.at(500) });
  h.filter.offer({ channel: 'you', text: 'Yes.', ts: h.at(6000) });
  h.run(3000);
  assert.deepEqual(h.dropped, ['Yes.']);
  assert.deepEqual(h.published, ['them: Yes, that works for us.', 'you: Yes.']);
});

test('echo filter: with no meeting audio at all, mic lines are kept; flush() sends the held ones at once', () => {
  const h = harness();
  h.filter.offer({ channel: 'you', text: 'Hi, how are you? Can you hear me?', ts: h.at(0) });
  assert.deepEqual(h.published, []);
  h.filter.flush();
  assert.deepEqual(h.published, ['you: Hi, how are you? Can you hear me?']);
  h.run(5000);
  assert.equal(h.published.length, 1, 'never twice');
});
