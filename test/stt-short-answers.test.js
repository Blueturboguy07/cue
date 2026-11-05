// 0.2.12 smoke (Mac and Windows, cue-smoke-0212):
// 1 (medium) A short answer ("Right.", "No.") after a 2 s pause was lost
//   while the request before it was slow (2.5-4.7 s): flushChannel did not
//   feed the batcher while a request was in flight, so the next flush read
//   several seconds at once, and the batcher joined every waiting piece,
//   across pauses, into one request; whisper dropped the short answer at the
//   end of it. Now the batcher is fed while a request is in flight, and a
//   piece after a pause goes in its own request, in order. Only when the
//   channel is behind (the first waiting piece has waited 3 s) are long
//   pieces joined again, and a short reply never is.
// 2 (low) Stop, Start and Stop within ~5 s reused the notes call still
//   running: the notes missed the last turn, and "Meeting notes saved (13
//   turns)." was said twice. Now a second call follows with every turn, and
//   the status is said once, for the last Stop, with the turns of the notes.
// 3 (low) The lost-words notice quoted the 429 sentence ("Wait 2 seconds and
//   try again", which does not apply) and ended with ".)".
// 4 (low) A piece cut at the 14 s cap with no clause gap there ends in the
//   middle of a sentence: the "." whisper put there is dropped, so the text
//   after the cut does not read as a new sentence. (Cuts at a clause gap are
//   left as they are: there, a sentence end is as likely, and whisper's case
//   does not tell them apart.)
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UtteranceBatcher } = require('../src/publik-stt-batcher');
const { createMeetingStore } = require('../src/meetings');
const { createMeetingMemory } = require('../src/meeting-memory');
const { continuedText } = require('../src/stt');
const { readSource, fnFrom } = require('./source-text');
const { mainHarness } = require('./main-stt-harness');
const S = require('./stt-synth');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
// "No." spoken quietly: 420 ms at about -33 dBFS (12 voiced 30 ms frames).
const shortAnswer = () => S.speech(420, { amp: 600 });

// Where each request's audio sits in the recording (every piece is a slice
// of it), and checks that they follow each other with no overlap.
function placeRequests(audio, requests) {
  const spans = requests.map((r) => { const at = audio.indexOf(r.pcm); return { at, end: at + r.pcm.length }; });
  spans.forEach((s, i) => assert.ok(s.at >= 0, `request ${i + 1} is a slice of the recording`));
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].at >= spans[i - 1].end, `request ${i + 1} starts after request ${i} ends (nothing twice, in order)`);
  return spans;
}
const holds = (span, mark) => span.at <= mark.start && span.end >= mark.end;
const touches = (span, mark) => span.at < mark.end && span.end > mark.start;
// For a request that joins pieces across a pause (not one slice): does it
// hold all of a labelled part, or the middle 40 ms of it?
const hasAll = (pcm, audio, mark) => pcm.indexOf(audio.subarray(mark.start, mark.end)) >= 0;
const hasAny = (pcm, audio, mark) => { const mid = mark.start + Math.floor((mark.end - mark.start) / 4) * 2; return pcm.indexOf(audio.subarray(mid - 640, mid + 640)) >= 0; };

// ---- 1: a short answer after a pause, while a request is slow -------------

function sentenceThenAnswer(seed) {
  S.reseed(seed);
  return S.compose([
    { pcm: S.pause(900) }, { pcm: S.speech(3000), label: 'first' }, { pcm: S.pause(2000) },
    { pcm: S.speech(3000), label: 'second' }, { pcm: S.pause(2000) },
    { pcm: shortAnswer(), label: 'No.' }, { pcm: S.pause(3000) }
  ]);
}

test('1: batcher: a short answer that waits with the sentence before it is released alone, after that sentence', () => {
  S.reseed(201);
  const { audio, marks } = S.compose([
    { pcm: S.pause(600) }, { pcm: S.speech(3000), label: 'sentence' }, { pcm: S.pause(2000) },
    { pcm: shortAnswer(), label: 'No.' }, { pcm: S.pause(1500) }
  ]);
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t });
  // The whole window at once, as after a slow request.
  const first = b.push(audio);
  assert.ok(first, 'the sentence goes now');
  assert.ok(!hasAny(first, audio, marks[1]), 'the first request does not hold the short answer after the pause');
  const firstSpan = placeRequests(audio, [{ pcm: first }])[0];
  assert.ok(holds(firstSpan, marks[0]), 'the first request holds the sentence');
  assert.ok(!touches(firstSpan, marks[1]), 'and not the short answer after the pause');
  t += 2500;
  const second = b.push(null);
  assert.ok(second, 'the short answer goes 2.5 s later, alone');
  const [, secondSpan] = placeRequests(audio, [{ pcm: first }, { pcm: second }]);
  assert.ok(holds(secondSpan, marks[1]));
  assert.equal(b.push(null), null);
});

test('1: batcher: pieces that go on from a cut still go in one request (one stretch of talk), never over 14 s', () => {
  S.reseed(202);
  // 11 s of talk with a 210 ms clause gap every 2 s, then a pause: cut after 8 s at a gap, the rest goes on from the cut.
  const talk = [];
  for (let i = 0; i < 5; i++) { talk.push(S.speech(2000)); talk.push(S.pause(210)); }
  talk.push(S.speech(1000));
  const { audio } = S.compose([{ pcm: S.pause(600) }, { pcm: Buffer.concat(talk), label: 'talk' }, { pcm: S.pause(1500) }]);
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t });
  const out = b.push(audio);
  assert.ok(out);
  assert.ok(b.continuesCut(out) === false, 'the request starts after a pause');
  assert.ok(out.length / 32 > 9000, `the cut piece and the piece that goes on from it are one request (${out.length / 32} ms)`);
  assert.ok(out.length / 32 <= 14000);
  t += 2500;
  assert.equal(b.push(null), null, 'nothing is left over');
});

test('1: batcher: when it is behind (3 s), long pieces after pauses go together to catch up, but a short reply always goes alone', () => {
  S.reseed(203);
  const { audio, marks } = S.compose([
    { pcm: S.pause(600) }, { pcm: S.speech(3000), label: 'long 1' }, { pcm: S.pause(1500) },
    { pcm: S.speech(3000), label: 'long 2' }, { pcm: S.pause(1500) },
    { pcm: shortAnswer(), label: 'No.' }, { pcm: S.pause(1500) },
    { pcm: S.speech(3000), label: 'long 3' }, { pcm: S.pause(1500) }
  ]);
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t });
  assert.equal(typeof b.feed, 'function', 'the batcher can be fed while a request is in flight');
  b.feed(audio); // all of it arrives while a request is in flight
  t += 3000;
  const sent = [b.push(null)];
  for (let i = 0; i < 3; i++) { t += 2500; sent.push(b.push(null)); }
  const reqs = sent.filter(Boolean);
  assert.equal(reqs.length, 3, 'three requests');
  assert.ok(hasAll(reqs[0], audio, marks[0]) && hasAll(reqs[0], audio, marks[1]) && !hasAny(reqs[0], audio, marks[2]), 'long 1 and long 2 together (it had waited 3 s), not the short reply');
  assert.ok(hasAll(reqs[1], audio, marks[2]) && !hasAny(reqs[1], audio, marks[1]) && !hasAny(reqs[1], audio, marks[3]), 'the short reply alone');
  assert.ok(hasAll(reqs[2], audio, marks[3]) && !hasAny(reqs[2], audio, marks[2]), 'then long 3');
  const total = reqs.reduce((n, r) => n + r.length, 0);
  assert.ok(total < audio.length, 'nothing twice');
});

test('1: main.js: while a slow request is in flight, the audio goes into the batcher; after it, the next sentence and the short answer go as separate requests, in order', async () => {
  const { audio, marks } = sentenceThenAnswer(211);
  const h = mainHarness({ plan: [{ hold: true, text: 'First sentence.' }, { text: 'Second sentence.' }, { text: 'No.' }] });
  // Feed up to the end of the recording; request 1 (the first sentence) stays in flight all along.
  await h.feed(audio);
  assert.equal(h.requests.length, 1);
  assert.ok(h.ctx.publikSttBatchers.them.pendingMs() > 4000, `the audio after it is in the batcher, with its pauses (${h.ctx.publikSttBatchers.them.pendingMs()} ms)`);
  await h.release(1);
  await h.feed(Buffer.alloc(0), { thenTicks: 8 });
  assert.equal(h.requests.length, 3, h.events.join(' | '));
  const spans = placeRequests(audio, h.requests);
  assert.ok(holds(spans[0], marks[0]));
  assert.ok(holds(spans[1], marks[1]) && !touches(spans[1], marks[2]), 'request 2: the second sentence, without the short answer');
  assert.ok(holds(spans[2], marks[2]), 'request 3: the short answer, alone');
  assert.deepEqual(h.turns.map((x) => x.text), ['First sentence.', 'Second sentence.', 'No.']);
  assert.ok(h.requests[2].at - h.requests[1].at >= 2500, 'still at most one request per 2.5 s');
});

test('1: main.js: Stop while a slow request is in flight: the held sentence and the short answer go as separate requests in the stop flush', async () => {
  const { audio, marks } = sentenceThenAnswer(212);
  const h = mainHarness({ plan: [{ hold: true, text: 'First sentence.' }, { text: 'Second sentence.' }, { text: 'No.' }] });
  await h.feed(audio);
  assert.equal(h.requests.length, 1);
  const done = h.stop();
  await h.release(1);
  await done;
  assert.equal(h.requests.length, 3, h.events.join(' | '));
  const spans = placeRequests(audio, h.requests);
  assert.ok(holds(spans[1], marks[1]) && !touches(spans[1], marks[2]));
  assert.ok(holds(spans[2], marks[2]));
  assert.deepEqual(h.events.filter((e) => /^turn|^notes/.test(e)), ['turn: First sentence.', 'turn: Second sentence.', 'turn: No.', 'notes']);
});

// ---- 2: Stop, Start, Stop within seconds: the notes -----------------------

function notesHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-notes-'));
  const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
  const calls = [];
  const llmFactory = () => ({ ready: true, stream: (params) => new Promise((resolve) => calls.push({ params, resolve })) });
  const memory = createMeetingMemory({ store, llmFactory, now: () => 1_000_000, log: () => {}, minTurnsForNotes: 2 });
  for (let i = 1; i <= 13; i++) memory.onTurn({ channel: i % 2 ? 'them' : 'you', text: `turn ${i}`, ts: 1_000_000 + i });
  return { store, memory, calls, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const NOTES = 'Meeting Summary:\nThe team agreed to ship on Tuesday.\n\nKey Points:\n- Ship Tuesday\n\nDecisions:\n- Ship\n\nAction Items:\n- You: send the runbook\n\nFollow-Up:\n- None\n';

test('2: meeting memory: a refresh while a notes call runs, with a new turn, gets notes written from every turn (a second call)', async () => {
  const h = notesHarness();
  const first = h.memory.refreshNotes(); // Stop 1: 13 turns
  await settle();
  assert.equal(h.calls.length, 1);
  h.memory.onTurn({ channel: 'them', text: 'the last turn', ts: 1_000_100 }); // Start, one more turn
  const second = h.memory.refreshNotes(); // Stop 2, while call 1 still runs
  h.calls[0].resolve(NOTES);
  const a = await first;
  assert.equal(a.turns, 13, 'the first notes say what they were written from');
  assert.equal(h.store.get(h.memory.current.id).notesTurns, 13, 'not the 14 turns there were when it came back');
  await settle();
  assert.equal(h.calls.length, 2, 'one more call, for the turn the first did not have');
  assert.match(h.calls[1].params.turns[0].text, /the last turn/);
  h.calls[1].resolve(NOTES);
  const b = await second;
  assert.equal(b.turns, 14);
  assert.equal(h.store.get(h.memory.current.id).notesTurns, 14);
  h.done();
});

test('2: meeting memory: a refresh while a notes call runs, with no new turn, waits for that call (no second call)', async () => {
  const h = notesHarness();
  const first = h.memory.refreshNotes();
  const again = h.memory.refreshNotes();
  await settle();
  h.calls[0].resolve(NOTES);
  assert.equal(await again, await first);
  await settle();
  assert.equal(h.calls.length, 1);
  h.done();
});

test('2: main.js: Stop, Start and Stop again while the notes call runs: "Meeting notes saved" is said once, with every turn', async () => {
  const src = readSource('main.js');
  const m = /^function notesAfterStop\(.*$/m.exec(src);
  assert.ok(m, 'main.js says the notes status in notesAfterStop(memory, lastWords)');
  const decl = (/^let notesStatusFor = .*;$/m.exec(src) || [''])[0];
  const statuses = [];
  const ctx = vm.createContext({ send: (ch, p) => { if (ch === 'status') statuses.push(p.message); }, Promise });
  vm.runInContext(`${decl}\n${fnFrom(src, m[0])}\nthis.notesAfterStop = notesAfterStop;`, ctx);
  const h = notesHarness();
  const stop1 = ctx.notesAfterStop(h.memory, Promise.resolve());
  await settle();
  h.memory.onTurn({ channel: 'them', text: 'the last turn', ts: 1_000_100 });
  const stop2 = ctx.notesAfterStop(h.memory, Promise.resolve());
  await settle();
  h.calls[0].resolve(NOTES);
  await settle();
  h.calls[1].resolve(NOTES);
  await Promise.all([stop1, stop2]);
  assert.deepEqual(statuses, ['Meeting notes saved (14 turns).']);
  h.done();
});

// ---- 3: the lost-words notice ---------------------------------------------

const BUSY = 'publik API is busy right now. Wait 2 seconds and try again, or use your own key in Settings.';

test('3: lost-words notice after two 429s: says why in its own words, no "try again", no ".)"', async () => {
  S.reseed(231);
  const h = mainHarness({ plan: [{ status: 429, message: BUSY }, { status: 429, message: BUSY }] });
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]), { thenTicks: 10 });
  assert.equal(h.requests.length, 2, h.events.join(' | '));
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^\d+ s of the meeting were not transcribed because publik API was busy\. Listening goes on\.$/);
  h.ctx.lostErr = { provider: 'publik', status: 429, message: BUSY };
  const atStop = vm.runInContext('lostAudioMessage(96000, lostErr, true)', h.ctx);
  assert.equal(atStop, 'The last 3 s before Stop were not transcribed because publik API was busy.');
  for (const n of [h.notices[0], atStop]) {
    assert.ok(!/try again|Wait 2 seconds/.test(n), n);
    assert.ok(!/\.\)|\(\s*\)/.test(n), n);
  }
});

// ---- 4: text after a cut at the cap with no clause gap ----------------------

test('4: a piece cut at the 14 s cap with no clause gap: its text loses the "." whisper put at the cut, so the next piece is not a new sentence', async () => {
  S.reseed(241);
  const h = mainHarness({ plan: [{ text: 'The payment service goes down and we reroute the traffic for the next.' }, { text: 'morning and the customer is told.' }] });
  await h.feed(Buffer.concat([S.pause(900), S.speech(20000), S.pause(2000)]), { thenTicks: 8 });
  assert.equal(h.requests.length, 2, h.events.join(' | '));
  assert.ok(h.requests[0].pcm.length / 32 > 13000, 'the first piece is cut at the cap');
  assert.equal(h.turns[0].text, 'The payment service goes down and we reroute the traffic for the next');
  assert.equal(h.requests[1].context, 'The payment service goes down and we reroute the traffic for the next', 'whisper reads the next piece after text with no sentence end');
  assert.equal(continuedText('morning and the customer is told.', h.requests[1].context), 'morning and the customer is told.', 'so it is not given a capital');
});

test('4: a piece cut at a clause gap keeps its "." (a sentence may end there)', async () => {
  S.reseed(242);
  const h = mainHarness({ plan: [{ text: 'We moved the launch to Friday.' }, { text: 'and the team agreed.' }] });
  await h.feed(Buffer.concat([S.pause(900), S.speech(9000), S.pause(250), S.speech(4500), S.pause(2000)]), { thenTicks: 8 });
  assert.equal(h.requests.length, 2, h.events.join(' | '));
  assert.ok(h.requests[0].pcm.length / 32 < 13000, 'cut at the clause gap, before the cap');
  assert.equal(h.turns[0].text, 'We moved the launch to Friday.');
  assert.equal(h.requests[1].context, 'We moved the launch to Friday.');
});
