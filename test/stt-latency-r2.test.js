// Round 2 of the meeting-audio cuts (blind verify of dcfd238):
// 1. With no 600 ms pause (quick turns, music or steady noise above the
//    silence level) a sentence reached whisper only at the 28 s cap: its
//    text came 18-28 s after it ended, and "What should I say?" could not
//    see the question. Now: a cut at the next clause gap after 8 s, a cut at
//    the latest clause gap once the first one is 6.5 s old (each cut waits
//    for 1.2 s more speech), a 14 s cap, and a
//    silence level that follows the noise floor.
// 2. Quiet short answers ("No." at about -33 to -40 dBFS) were dropped as a
//    cough by the 300 ms voiced minimum. Now 120 ms; a click is still dropped.
// 3. (renderer: test/answer-area-ui.test.js)
// 4. A failed whisper request lost its piece, and stopping the session in
//    mid-speech dropped the held audio. Now: one more try after a pause, and
//    the held audio is sent as a final piece at the stop.
// Audio: test/stt-synth.js, fed the way main.js feeds the batcher (256 ms
// chunks, a 900 ms flush, no flush while a 1.2 s transcription is in flight).
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const { readSource, fnFrom } = require('./source-text');
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');
const S = require('./stt-synth');

const secs = (n) => Math.round(n * 32000 / 2) * 2;

// Quick turns: two voices take turns of 1.5-4 s with only a short gap between them.
function quickTurns(gapMs, n = 24) {
  S.reseed(gapMs);
  const parts = [{ pcm: S.pause(1500) }];
  const lens = [2400, 3990, 1500, 3510, 2010, 3000];
  for (let i = 0; i < n; i++) { parts.push({ pcm: S.speech(lens[i % lens.length]), label: `turn ${i + 1}` }); parts.push({ pcm: S.pause(gapMs) }); }
  parts.push({ pcm: S.pause(4000) });
  return parts;
}
// Sentences with a 700 ms pause after each one.
function sentences(n = 6) {
  S.reseed(7);
  const parts = [{ pcm: S.pause(1500) }];
  const lens = [4980, 9990, 6000, 12000, 3000, 7500];
  for (let i = 0; i < n; i++) { parts.push({ pcm: S.speech(lens[i % lens.length]), label: `sentence ${i + 1}` }); parts.push({ pcm: S.pause(690) }); }
  parts.push({ pcm: S.pause(4000) });
  return parts;
}
const worst = (d) => d.reduce((a, m) => (m.textAfterEnd > a.textAfterEnd ? m : a));
const table = (d) => d.map((m) => `${m.label}: ${m.textAfterEnd} ms`).join(', ');

for (const gap of [250, 450]) {
  test(`quick turns with ${gap} ms gaps, no long pause: every turn's text arrives within 10 s of its end`, () => {
    const { audio, marks } = S.compose(quickTurns(gap));
    const { sends } = S.drive(audio);
    const d = S.delays(audio, marks, sends);
    assert.ok(d.every((m) => m.send >= 0), 'every turn was sent');
    const w = worst(d);
    assert.ok(w.textAfterEnd <= 10000, `${w.label}: text ${w.textAfterEnd} ms after it ended\n${table(d)}`);
    for (const s of sends) assert.ok(s.pcm.length <= secs(14), `a request of ${S.ms(s.pcm)} ms`);
  });
}

for (const [name, bed] of [['music', S.music(330)], ['steady noise (RMS 190)', S.noise(190)]]) {
  test(`${name} above the gate under the talk: each sentence is cut at its pause and its text arrives within 4 s of its end`, () => {
    const { audio, marks } = S.compose(sentences(), bed);
    const { sends } = S.drive(audio);
    const d = S.delays(audio, marks, sends);
    assert.ok(d.every((m) => m.send >= 0), 'every sentence was sent');
    const w = worst(d);
    assert.ok(w.textAfterEnd <= 4000, `${w.label}: text ${w.textAfterEnd} ms after it ended\n${table(d)}`);
  });
}

test('music alone is not speech: after 3 s it is never sent', () => {
  S.reseed(3);
  const { audio } = S.compose([{ pcm: S.pause(60000) }], S.music(330));
  const { sends } = S.drive(audio);
  const sent = sends.reduce((n, s) => n + S.ms(s.pcm), 0);
  assert.ok(sent <= 3500, `${sent} ms of music sent to whisper`);
});

test('no clause gap at all (40 s, only 60 ms gaps between syllables): every syllable\'s text arrives within 15 s, pieces of at most 14 s', () => {
  S.reseed(11);
  const parts = [{ pcm: S.pause(1500) }];
  for (let i = 0; i < 10; i++) parts.push({ pcm: S.speech(3990), label: `part ${i + 1}` });
  parts.push({ pcm: S.pause(4000) });
  const { audio, marks } = S.compose(parts);
  const { sends } = S.drive(audio);
  const d = S.delays(audio, marks, sends);
  const w = worst(d);
  assert.ok(w.textAfterEnd <= 15000, `${w.label}: text ${w.textAfterEnd} ms after it was spoken\n${table(d)}`);
  for (const s of sends) assert.ok(s.pcm.length <= secs(14), `a request of ${S.ms(s.pcm)} ms`);
});

test('a long question (14 s) with normal clause pauses goes as at most 2 pieces, cut only in a clause pause', () => {
  S.reseed(5);
  const parts = [{ pcm: S.pause(1500) }];
  for (const len of [3000, 2490, 3510, 2010, 3000]) { parts.push({ pcm: S.speech(len) }); parts.push({ pcm: S.pause(240) }); }
  parts.push({ pcm: S.pause(3000) });
  const { audio } = S.compose(parts);
  const { sends } = S.drive(audio);
  assert.ok(sends.length >= 1 && sends.length <= 2, `${sends.length} pieces: ${sends.map((s) => S.ms(s.pcm)).join(', ')} ms`);
  for (let i = 1; i < sends.length; i++) {
    const prev = sends[i - 1].pcm;
    assert.ok(S.rms(prev.subarray(prev.length - 960)) < S.GATE && S.rms(sends[i].pcm.subarray(0, 960)) < S.GATE, 'the cut is in a pause');
  }
});

test('a sentence that ends soon after a clause gap is not cut there: no short tail goes to whisper alone (the 0.2.11 smoke sentence)', () => {
  // "Thanks for joining the call. Our team builds ... stores. Tell me about a
  // time you had to meet a tight deadline, | and what you learned from it."
  S.reseed(12);
  for (const tail of [600, 1020]) {
    const parts = [{ pcm: S.pause(990) }, { pcm: S.speech(1500) }, { pcm: S.pause(360) }, { pcm: S.speech(3000) }, { pcm: S.pause(300) }, { pcm: S.speech(2400) }, { pcm: S.pause(210) }, { pcm: S.speech(tail) }, { pcm: S.pause(3000) }];
    const { audio } = S.compose(parts);
    const { sends } = S.drive(audio);
    assert.equal(sends.length, 1, `tail ${tail} ms: pieces ${sends.map((x) => S.ms(x.pcm)).join(', ')} ms`);
  }
  // Past 8 s too: a clause gap, then 0.9 s of speech and the end.
  const { audio } = S.compose([{ pcm: S.pause(990) }, { pcm: S.speech(8490) }, { pcm: S.pause(240) }, { pcm: S.speech(900) }, { pcm: S.pause(3000) }]);
  assert.equal(S.drive(audio).sends.length, 1);
});

test('quiet short answers (150-240 ms of speech at about -36 dBFS) are sent; a 60-90 ms click is not', () => {
  S.reseed(9);
  for (const [len, amp] of [[150, 600], [180, 520], [240, 450]]) {
    const { audio } = S.compose([{ pcm: S.pause(2000) }, { pcm: S.speech(len, { gaps: false, amp }) }, { pcm: S.pause(3000) }]);
    const { sends } = S.drive(audio);
    assert.equal(sends.length, 1, `a ${len} ms answer at amplitude ${amp} was dropped`);
  }
  for (const len of [60, 90]) {
    const { audio } = S.compose([{ pcm: S.pause(2000) }, { pcm: S.speech(len, { gaps: false, amp: 8000 }) }, { pcm: S.pause(3000) }]);
    assert.equal(S.drive(audio).sends.length, 0, `a ${len} ms click was sent`);
  }
});

// ---- 4. one more try, and the last words at the stop ----------------------

test('retry: a failed piece goes again first and alone, after its delay and the 2.5 s spacing; a second failure is final', () => {
  let t = 100000;
  const b = new UtteranceBatcher({ now: () => t });
  const sentence = (seed) => { S.reseed(seed); return Buffer.concat([S.speech(3000), S.pause(900)]); };
  let piece = b.push(sentence(1));
  for (let i = 0; i < 3 && !piece; i++) { t += 900; piece = b.push(null); }
  assert.ok(piece, 'the first sentence was sent');
  assert.equal(b.retry(piece, 5000), true, 'queued once more');
  t += 900; b.push(sentence(2)); // the next sentence is ready behind it
  for (let i = 0; i < 2; i++) { t += 900; b.push(null); }
  t += 900; assert.equal(b.push(null), null, '3.6 s after the failure: still waiting for the 5 s delay, and nothing passes it');
  t += 1500; const again = b.push(null);
  assert.equal(again, piece, 'the same piece, alone, first');
  assert.equal(b.retry(again, 2500), false, 'a second failure is final');
  t += 2500; const next = b.push(null);
  assert.ok(next && next !== piece && next.length > 0, 'then the next sentence');
});

test('flush at the stop: the sentence in progress is returned, not dropped; a click is not; the batcher is empty after', () => {
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t });
  S.reseed(4);
  const audio = Buffer.concat([S.pause(990), S.speech(4500)]);
  const win = 0.9 * BYTES_PER_SECOND;
  for (let off = 0; off + win <= audio.length; off += win) { t += 900; assert.equal(b.push(audio.subarray(off, off + win)), null); }
  const rest = audio.subarray(Math.floor(audio.length / win) * win); // arrived since the last tick
  const pieces = b.flush(rest);
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].equals(audio.subarray(S.at(990 - 210))), 'the whole sentence, to its last sample');
  assert.equal(b.pendingMs(), 0);
  assert.deepEqual(b.flush(null), []);
  b.push(Buffer.concat([S.pause(990), S.speech(60, { gaps: false, amp: 8000 })]));
  assert.deepEqual(b.flush(null), [], 'a click held at the stop is not sent');
});

// main.js, run in a vm: flushChannel with a whisper that fails once.
function mainHarness({ errors = [] } = {}) {
  const src = readSource('main.js');
  const code = [
    fnFrom(src, 'async function flushChannel(channel) {'),
    fnFrom(src, 'function isPassingSttError(err) {'),
    fnFrom(src, 'function sttRetryDelayMs(err) {'),
    fnFrom(src, 'function transcribePiece(channel, pcm, settings, stt, canRetry) {'),
    fnFrom(src, 'function takeHeldAudio() {'),
    fnFrom(src, 'async function sendHeldAudio(held) {')
  ].join('\n');
  let t = 1e6;
  const calls = []; const notices = []; const turns = []; const reported = [];
  const pending = errors.slice();
  const stt = {
    available: true, providers: ['publik'],
    transcribe: async (pcm) => { calls.push(pcm); const e = pending.shift(); return e ? { text: '', error: { provider: 'publik', message: 'busy', ...e } } : { text: `text ${calls.length}`, provider: 'publik' }; }
  };
  const ctx = vm.createContext({
    state: { capturing: true, transcribing: { you: false, them: false } },
    buffers: { you: [], them: [] },
    publikSttBatchers: { you: new UtteranceBatcher({ now: () => t }), them: new UtteranceBatcher({ now: () => t }) },
    sttInFlight: { you: Promise.resolve(), them: Promise.resolve() },
    store: { getSettings: () => ({}) }, createSTT: () => stt, publik: { PUBLIK_PROVIDER: 'publik' },
    MIN_BYTES: 3840, RMS_GATE: 180, rms16: S.rms, DEFAULT_MIN_GAP_MS: 2500, sttDisabled: false,
    send: (ch, p) => { if (ch === 'status') notices.push(p.message); },
    pushTranscript: (turn) => turns.push(turn), recordEvent: () => {}, noTranscriptionMessage: () => 'off',
    handleSttError: (err) => reported.push(err), console, Date: { now: () => t }, Buffer, Promise,
    setTimeout: (fn) => { fn(); return 0; }
  });
  vm.runInContext(code + '\nthis.api = { flushChannel, takeHeldAudio, sendHeldAudio };', ctx);
  return { api: ctx.api, ctx, calls, turns, reported, notices, tick: (ms) => { t += ms; } };
}

test('main.js: a 503 from whisper is not reported; the same piece is sent once more after the spacing and its text is published once', async () => {
  const h = mainHarness({ errors: [{ status: 503 }] });
  S.reseed(8);
  const audio = Buffer.concat([S.pause(900), S.speech(3000), S.pause(2700)]);
  const win = 0.9 * BYTES_PER_SECOND;
  for (let off = 0; off < audio.length; off += win) { h.ctx.buffers.them.push(audio.subarray(off, off + win)); h.tick(900); await h.api.flushChannel('them'); }
  for (let i = 0; i < 6; i++) { h.tick(900); await h.api.flushChannel('them'); }
  assert.equal(h.calls.length, 2, `${h.calls.length} whisper calls`);
  assert.ok(h.calls[1].equals(h.calls[0]), 'the second call is the same piece');
  assert.equal(h.reported.length, 0, 'a failure that was tried again is not reported');
  assert.equal(h.turns.length, 1);
});

test('main.js: a second failure of the same piece is reported once (the "Transcription paused" path), and listening goes on', async () => {
  const h = mainHarness({ errors: [{ status: 429 }, { status: 429 }] });
  S.reseed(8);
  const audio = Buffer.concat([S.pause(900), S.speech(3000), S.pause(2700)]);
  const win = 0.9 * BYTES_PER_SECOND;
  for (let off = 0; off < audio.length; off += win) { h.ctx.buffers.them.push(audio.subarray(off, off + win)); h.tick(900); await h.api.flushChannel('them'); }
  for (let i = 0; i < 10; i++) { h.tick(900); await h.api.flushChannel('them'); }
  assert.equal(h.calls.length, 2);
  assert.equal(h.reported.length, 1);
  assert.equal(h.reported[0].status, 429);
});

test('main.js: at the stop, the sentence still being spoken is sent as a final piece (with its one more try), before the batcher is cleared and before the notes', async () => {
  const h = mainHarness({ errors: [{ status: 502 }] });
  S.reseed(6);
  const audio = Buffer.concat([S.pause(900), S.speech(4200)]);
  const win = 0.9 * BYTES_PER_SECOND;
  let off = 0;
  for (; off + win <= audio.length; off += win) { h.ctx.buffers.them.push(audio.subarray(off, off + win)); h.tick(900); await h.api.flushChannel('them'); }
  h.ctx.buffers.them.push(audio.subarray(off)); // arrived after the last tick
  assert.equal(h.calls.length, 0, 'nothing sent while the sentence goes on');
  await h.api.sendHeldAudio(h.api.takeHeldAudio());
  assert.equal(h.calls.length, 2, 'the final piece, and its one more try after the 502');
  assert.ok(h.calls[0].equals(audio.subarray(S.at(900 - 210))), 'the whole sentence, to the stop');
  assert.equal(h.turns.length, 1);
  const src = readSource('main.js');
  const stop = src.slice(src.indexOf('  state.capturing = false;\n  stopFlushLoop();'));
  assert.ok(stop.indexOf('sendHeldAudio(takeHeldAudio())') > -1 && stop.indexOf('sendHeldAudio(takeHeldAudio())') < stop.indexOf('publikSttBatchers.you.reset()'), 'taken before the reset');
  assert.match(stop, /lastWords\.then\(\(\) => memory\.refreshNotes\(\)\)/, 'the notes wait for the last words');
});

test('stt.js: publik transcription answers within 30 s or fails (no 10 min hang), with no SDK retries; Retry-After is read', () => {
  const stt = require('../src/stt');
  assert.deepEqual(stt.PUBLIK_STT_CLIENT, { timeout: 30000, maxRetries: 0 });
  assert.equal(stt.retryAfterHeaderMs({ headers: { 'retry-after': '7' } }), 7000);
  assert.equal(stt.retryAfterHeaderMs({ headers: { 'retry-after-ms': '1500' } }), 1500);
  assert.equal(stt.retryAfterHeaderMs({ headers: {} }), 0);
  assert.equal(stt.retryAfterHeaderMs({}), 0);
});
