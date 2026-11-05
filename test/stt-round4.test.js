// Round 4 of the meeting-audio cuts (blind re-verify of ba8a0fe):
// 1. The repeat removal deleted real words, silently: a piece after a cut
//    that began with 3 or more words that end the text before it lost them
//    ("go back, go back, until the old build" -> "Until the old build",
//    "talk to the team about the tests" -> "About the tests"), and a piece
//    that only repeated became empty. whisper read its prompt back in 0 of
//    the live pieces, so it fixed nothing. It is gone: a repeat is kept.
// 2. A retry that was already waiting at Stop went out 2.5 s later, not
//    after what was left of its Retry-After (15 s). Now it waits that long
//    (at most 20 s; the stop flush still starts nothing after 40 s).
// 3. Stop, then Start within about a second, threw away text whisper had
//    already sent back, with no reason in the notice. Now that text is kept
//    while the new session has shown nothing (so the order holds); else it
//    is said as lost, with the reason.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');
const { createSTT } = require('../src/stt');
const { mainHarness } = require('./main-stt-harness');
const S = require('./stt-synth');

// ---- 1. a repeat across a cut is kept -----------------------------------

// A local server stands in for publik and answers each request in turn.
function publikServer(answers) {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: answers[n++] || '' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const REPEATS = [
  ['"go back, go back" said again after the cut',
    'When the release failed on Friday night, the lead kept saying go back, go back, go back.',
    'go back, go back, until the old build was running again on every server in the cluster.',
    'Go back, go back, until the old build was running again on every server in the cluster.'],
  ['the speaker starts the clause again ("talk to the team")',
    'The first thing I would do in that situation is to sit down and talk to the team.',
    'talk to the team about the tests, the on-call load and the release dates.',
    'Talk to the team about the tests, the on-call load and the release dates.'],
  ['"one more time" said once more',
    'We said one more time, one more time.',
    'One more time, and then we stopped.',
    'One more time, and then we stopped.'],
  ['a piece that only repeats the clause before it',
    'and how you told your manager about it.',
    'your manager about it.',
    'Your manager about it.']
];

for (const [name, context, said, shown] of REPEATS) {
  test(`1: a repeat across a cut keeps every word: ${name}`, async () => {
    const srv = await publikServer([said]);
    try {
      const settings = { provider: 'publik', apiKeys: { publik: 'test-publik-key' }, publik: { baseUrl: srv.url } };
      S.reseed(101);
      const res = await createSTT(settings).transcribe(S.speech(1500), { context });
      assert.equal(res.text, shown);
    } finally { srv.server.close(); }
  });
}

// ---- 2. a retry already waiting at Stop ----------------------------------

// A sentence and its pause: piece 1 goes out and fails at once; a little
// more speech; then Stop while the one more try of piece 1 waits.
async function failThenStop(h, seed, msAfterFail) {
  S.reseed(seed);
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]));
  assert.equal(h.requests.length, 1);
  const failedAt = h.requests[0].at;
  await h.feed(S.speech(Math.max(900, msAfterFail - 900)));
  assert.equal(h.requests.length, 1, 'the one more try still waits');
  const stoppedAt = h.now();
  await h.stop();
  return { failedAt, stoppedAt };
}

test('2: a retry already waiting at Stop (429, Retry-After 15 s) goes out when its Retry-After ends, not 2.5 s after Stop; the notes come after', async () => {
  const h = mainHarness({ plan: [{ status: 429, retryAfterMs: 15000 }, { text: 'retried' }, { text: 'held' }] });
  const { failedAt, stoppedAt } = await failThenStop(h, 111, 2700);
  assert.ok(stoppedAt - failedAt < 5000, `Stop came ${stoppedAt - failedAt} ms after the 429`);
  assert.equal(h.requests.length, 3, h.events.join(' | '));
  assert.ok(h.requests[1].pcm.equals(h.requests[0].pcm), 'request 2 is the one more try of piece 1');
  const after = h.requests[1].at - failedAt;
  assert.ok(after >= 15000 && after < 16000, `the one more try went ${after} ms after the 429 (Retry-After 15 s)`);
  assert.deepEqual(h.turns.map((x) => x.text), ['retried', 'held']);
  assert.equal(h.notices.length, 0);
  assert.equal(h.events[h.events.length - 1], 'notes');
});

test('2: a waiting retry with Retry-After over 20 s goes out 20 s after the 429 at most', async () => {
  const h = mainHarness({ plan: [{ status: 429, retryAfterMs: 90000 }, { text: 'retried' }, { text: 'held' }] });
  const { failedAt } = await failThenStop(h, 112, 2700);
  assert.equal(h.requests.length, 3, h.events.join(' | '));
  const after = h.requests[1].at - failedAt;
  assert.ok(after >= 20000 && after < 21000, `the one more try went ${after} ms after the 429`);
  assert.deepEqual(h.turns.map((x) => x.text), ['retried', 'held']);
});

// ---- 3. Stop, then Start at once ------------------------------------------

// Returns { done }: the stop path's promise (the notes come when it ends).
// Request 1 is in flight at Stop; the next sentence is held.
async function inFlightAtStop(h, seed) {
  S.reseed(seed);
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]));
  assert.equal(h.requests.length, 1);
  await h.feed(S.speech(2400));
  assert.equal(h.requests.length, 1);
  return { done: h.stop() };
}

test('3: Stop, then Start before the text came back: the text is kept (transcript and notes) while the new session has shown nothing; the piece not yet sent is said with its reason', async () => {
  const h = mainHarness({ plan: [{ text: 'the old last words', hold: true }, { text: 'never sent' }] });
  const { done } = await inFlightAtStop(h, 121);
  h.start();
  await h.release(1);
  await done;
  assert.deepEqual(h.turns.map((x) => x.text), ['the old last words']);
  assert.ok(h.events.indexOf('turn: the old last words') < h.events.indexOf('notes'), 'in the notes');
  assert.equal(h.requests.length, 1, 'the held piece is not sent in the new session');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^The last \d+ s before Stop were not transcribed \(a new session started first\)\.$/);
});

test('3: when the new session shows text first, the old text that comes back later is not shown (the order holds); the notice gives the reason', async () => {
  const h = mainHarness({ plan: [{ text: 'the old last words', hold: true }, { text: 'new words' }] });
  const { done } = await inFlightAtStop(h, 122);
  h.start();
  S.reseed(123);
  await h.feed(Buffer.concat([S.pause(900), S.speech(2400), S.pause(1800)]), { channel: 'you', thenTicks: 2 });
  assert.deepEqual(h.turns.map((x) => x.text), ['new words']);
  await h.release(1);
  await done;
  assert.deepEqual(h.turns.map((x) => x.text), ['new words']);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^The last \d+ s before Stop were not transcribed \(a new session started first\)\.$/);
});
