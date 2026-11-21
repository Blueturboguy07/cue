// Round 3 of the meeting-audio cuts (blind re-verify of eee01af):
// N1 a cut inside a long sentence changed words live ("what interested you"
//    -> "What interest did you", "My lead" -> "MyLED"): the deadline cut took
//    the LATEST clause gap, and whisper read each piece with no context. Now
//    the cut takes the LONGEST clause gap with at least 4 s before it (most
//    often a sentence end), and a piece that starts at a cut is sent with
//    the text before it as whisper context.
// N2 a request that failed after Stop went into the next session (its first
//    request, old words out of order), with no notice, and the notes missed
//    it. Now the stop flush gives it its one more try before the notes, a new
//    session never gets anything from an old one, and a lost piece is said.
// N3 a 429 near Stop dropped the last words: the stop retry ignored
//    Retry-After, and the transcriber's 30 s local back-off blocked the next
//    tries while the status said "waiting 30s before retrying". Now the stop
//    flush honors Retry-After (up to 20 s), uses a fresh transcriber for each
//    try, and says what was lost.
// Also the verifier's P1 and P3 checks, under the new rules.
const assert = require('node:assert/strict');
const test = require('node:test');
const { UtteranceBatcher } = require('../src/publik-stt-batcher');
const { mainHarness } = require('./main-stt-harness');
const S = require('./stt-synth');

// ---- N1: where a long sentence is cut ----------------------------------

test('N1: a cut takes the longest clause gap with 4 s before it (a sentence end), not the latest comma; both pieces >= 4 s', () => {
  S.reseed(31);
  // speech 1.5 s | 240 ms | 3.3 s | 390 ms (sentence end) | 1.2 s | 210 ms (comma) | 4.0 s | pause.
  // The first gap is 6.5 s old at about 8 s; the latest gap then is the comma.
  const parts = [{ pcm: S.pause(990) }, { pcm: S.speech(1500) }, { pcm: S.pause(240) }, { pcm: S.speech(3300) }, { pcm: S.pause(390) }, { pcm: S.speech(1200) }, { pcm: S.pause(210) }, { pcm: S.speech(4000) }, { pcm: S.pause(3000) }];
  const { audio } = S.compose(parts);
  const { sends } = S.drive(audio);
  assert.equal(sends.length, 2, `pieces ${sends.map((x) => S.ms(x.pcm)).join(', ')} ms`);
  const cut = 990 - 210 + S.ms(sends[0].pcm); // the first piece starts 210 ms (pre-roll) before the speech
  const gapB = 990 + 1500 + 240 + 3300;
  assert.ok(cut > gapB && cut < gapB + 390, `cut at ${cut} ms; the sentence-end gap is ${gapB}-${gapB + 390} ms, the comma ${gapB + 390 + 1200}-${gapB + 390 + 1200 + 210} ms`);
  for (const x of sends) assert.ok(S.ms(x.pcm) >= 4000, `a piece of ${S.ms(x.pcm)} ms`);
});

// The verifier's P1 and P3 checks, under the new rules. Each part is
// speech or a pause (a clause gap of 180-300 ms, or a 3 s pause); a bed
// (music, steady noise) can lie over the whole recording.
//   - each send is an exact slice of the audio, after the one before:
//     nothing sent twice, nothing out of order;
//   - every speech frame of the CLEAN signal was sent (none lost);
//   - two sends that touch are a cut: it lies inside a pause part (a gap of
//     180 ms or more, never inside a word or a 60 ms syllable gap), and the
//     piece before it holds at least `minHeadMs` (4 s; 3 s for continuous
//     talk, where a 3 s sentence between two cuts is a piece of its own).
const FR = 960;
function checkPieces(parts, bed, label, minHeadMs = 4000) {
  const clean = Buffer.concat(parts.map((p) => p.pcm));
  const { audio } = S.compose(parts, bed);
  const { sends, delivered } = S.drive(audio);
  const pauses = []; let off = 0;
  for (const p of parts) { if (p.gap) pauses.push({ from: off, to: off + p.pcm.length }); off += p.pcm.length; }
  let end = 0;
  const sp = sends.map((x, i) => {
    const at = audio.indexOf(x.pcm, end);
    assert.ok(at >= 0, `${label}: send ${i + 1} is not a slice of the audio after send ${i}`);
    end = at + x.pcm.length;
    return { from: at, to: end };
  });
  const sizes = sp.map((x) => `${((x.to - x.from) / 32000).toFixed(1)}`).join(', ');
  let cuts = 0;
  for (let i = 1; i < sp.length; i++) {
    if (sp[i].from !== sp[i - 1].to) continue;
    cuts++;
    const cut = sp[i].from;
    assert.ok(pauses.some((g) => cut >= g.from && cut <= g.to), `${label}: cut ${cuts} at ${Math.round(cut / 32)} ms is not in a gap (pieces ${sizes} s)`);
    assert.ok(sp[i - 1].to - sp[i - 1].from >= minHeadMs * 32, `${label}: the piece before cut ${cuts} is under ${minHeadMs} ms (pieces ${sizes} s)`);
  }
  let speechFrames = 0; let lost = 0;
  for (let o = 0; o + FR <= delivered; o += FR) {
    if (S.rms(clean.subarray(o, o + FR)) < S.GATE) continue;
    speechFrames++;
    if (!sp.some((x) => x.from <= o && x.to >= o + FR)) lost++;
  }
  assert.ok(speechFrames > 1000);
  assert.equal(lost, 0, `${label}: ${lost} of ${speechFrames} speech frames lost`);
  return { cuts, sp };
}
const said = (lens, gaps) => lens.flatMap((len, i) => [{ pcm: S.speech(len) }, ...(i < gaps.length ? [{ pcm: S.pause(gaps[i]), gap: true }] : [])]);
// Long questions (9.9-20.1 s), clause gaps of 180-300 ms, 3 s pauses.
const longQuestions = () => [{ pcm: S.pause(1500) },
  ...said([1500, 3990, 4410], [180, 210]), { pcm: S.pause(3000), gap: true },
  ...said([2010, 2490, 3000, 3300], [270, 180, 240]), { pcm: S.pause(3000), gap: true },
  ...said([3510, 4500, 3000], [300, 210]), { pcm: S.pause(3000), gap: true },
  ...said([2490, 2700, 2400, 1500, 4500, 1500, 1500, 2700], [240, 300, 210, 180, 240, 300, 180]), { pcm: S.pause(3000) }];
// Continuous talk: sentences with 200 ms gaps only, no pause.
const continuousTalk = () => [{ pcm: S.pause(1500) }, ...said([4980, 9990, 6000, 12000, 3000, 7500], [200, 200, 200, 200, 200]), { pcm: S.pause(4000) }];

test('P1 (verifier, new rules): long questions (9.9-20.1 s, clause gaps of 180-300 ms, 3 s pauses): every cut in a gap, the piece before a cut >= 4 s, nothing lost, sent twice or out of order', () => {
  S.reseed(41);
  const { cuts } = checkPieces(longQuestions(), null, 'P1');
  assert.ok(cuts >= 4, `${cuts} cuts: the questions over 10 s are cut (the 10 s rule)`);
});

for (const [name, bed] of [['music', S.music(330)], ['steady noise (RMS 190)', S.noise(190)]]) {
  test(`P3 (verifier, new rules): under ${name}, long questions and continuous talk: 0 speech frames lost against the clean signal, every cut in a gap, nothing sent twice or out of order`, () => {
    S.reseed(41);
    checkPieces(longQuestions(), bed, `questions under ${name}`);
    S.reseed(51);
    checkPieces(continuousTalk(), bed, `continuous talk under ${name}`, 3000);
  });
}

test('N1: a piece that starts at a cut is sent with the text before it as whisper context; a piece after a pause is not', async () => {
  const h = mainHarness({ plan: [{ text: 'Before we move on, I would like to hear how you learned about our team,' }, { text: 'what interested you about this role.' }, { text: 'Thanks.' }] });
  S.reseed(61);
  // 13 s of talk with clause gaps (cut by the deadline), a pause, then a short sentence.
  const audio = Buffer.concat([S.pause(990), S.speech(1500), S.pause(240), S.speech(3300), S.pause(390), S.speech(2400), S.pause(210), S.speech(3000), S.pause(1500), S.speech(1500), S.pause(3000)]);
  await h.feed(audio, { thenTicks: 6 });
  assert.equal(h.requests.length, 3, h.requests.map((r) => `${r.n}: ${S.ms(r.pcm)} ms`).join(', '));
  assert.equal(h.requests[0].context, '', 'the first piece has nothing before it');
  assert.equal(h.requests[1].context, 'Before we move on, I would like to hear how you learned about our team,', 'the piece after the cut gets the text before it');
  assert.equal(h.requests[2].context, '', 'a sentence after a pause gets no context');
});

test('N1: the batcher marks only pieces that start at a cut (also when merged)', () => {
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t });
  S.reseed(62);
  const audio = Buffer.concat([S.pause(990), S.speech(1500), S.pause(240), S.speech(3300), S.pause(390), S.speech(2400), S.pause(210), S.speech(3000), S.pause(3000), S.speech(1500), S.pause(3000)]);
  const out = [];
  for (let off = 0; off < audio.length; off += 28800) { t += 900; const p = b.push(audio.subarray(off, off + 28800)); if (p) out.push(p); }
  for (let i = 0; i < 6; i++) { t += 900; const p = b.push(null); if (p) out.push(p); }
  assert.deepEqual(out.map((p) => b.continuesCut(p)), [false, true, false]);
});

// ---- N2: a request that fails after Stop --------------------------------

// Returns { done }: the stop path's promise (the notes come when it ends).
async function inFlightAtStop(h, seed) {
  S.reseed(seed);
  // A sentence and its pause: piece 1 goes out and is still in flight ...
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]));
  assert.equal(h.requests.length, 1);
  // ... while the next sentence is being said (held, not yet sent) when Stop comes.
  await h.feed(S.speech(2400));
  assert.equal(h.requests.length, 1);
  return { done: h.stop() };
}

test('N2: a request that fails (500) while Stop happens gets its one more try in the stop flush, before the notes; the next session never sees it', async () => {
  const h = mainHarness({ plan: [{ status: 500, hold: true }, { text: 'the first sentence' }, { text: 'the held sentence' }, { text: 'new session' }] });
  const { done } = await inFlightAtStop(h, 71);
  await h.release(1);
  await done;
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests[1].pcm.equals(h.requests[0].pcm), 'request 2 is the one more try of request 1');
  assert.deepEqual(h.events.filter((e) => /^turn|^notes/.test(e)), ['turn: the first sentence', 'turn: the held sentence', 'notes']);
  assert.equal(h.notices.length, 0);
  h.start();
  S.reseed(72);
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]), { thenTicks: 4 });
  assert.equal(h.requests.length, 4);
  assert.ok(!h.requests.slice(0, 3).some((r) => r.pcm.equals(h.requests[3].pcm)), 'the first request of the new session is new audio');
});

test('N2: when the one more try fails too, a notice says the last words were not transcribed, the notes come after, and the next session starts clean', async () => {
  const h = mainHarness({ plan: [{ status: 500, hold: true }, { status: 503 }, { text: 'the held sentence' }, { text: 'new session' }] });
  const { done } = await inFlightAtStop(h, 73);
  await h.release(1);
  await done;
  assert.equal(h.requests.length, 3);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^The last \d+ s before Stop were not transcribed because publik API had a server error\.$/);
  assert.deepEqual(h.events.slice(-2), [`status: ${h.notices[0]}`, 'notes']);
  h.start();
  S.reseed(74);
  await h.feed(Buffer.concat([S.pause(900), S.speech(3000), S.pause(1800)]), { thenTicks: 4 });
  assert.equal(h.requests.length, 4);
  assert.ok(!h.requests[0].pcm.equals(h.requests[3].pcm), 'the old piece is not the first request of the new session');
  assert.deepEqual(h.turns.map((x) => x.text), ['the held sentence', 'new session']);
});

// ---- N3: a 429 near Stop -------------------------------------------------

test('N3: 429 with Retry-After 15 s just before Stop, then a plain 429: the stop flush waits the 15 s, the local back-off does not block the last words, and the notice matches', async () => {
  const h = mainHarness({ plan: [{ status: 429, retryAfterMs: 15000, hold: true }, { status: 429 }, { text: 'the held sentence' }] });
  const { done } = await inFlightAtStop(h, 81);
  const failedAt = h.now();
  await h.release(1);
  await done;
  assert.equal(h.requests.length, 3, h.events.join(' | '));
  assert.ok(h.requests[1].at - failedAt >= 15000, `the one more try went ${h.requests[1].at - failedAt} ms after the 429 with Retry-After 15 s`);
  assert.ok(h.requests[1].pcm.equals(h.requests[0].pcm));
  assert.ok(h.requests[2].at - h.requests[1].at >= 5000, 'after a plain 429 the next request waits 5 s');
  assert.deepEqual(h.turns.map((x) => x.text), ['the held sentence'], 'the last words are transcribed');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^The last \d+ s before Stop were not transcribed because publik API was busy\.$/);
  assert.ok(!h.notices.some((n) => /waiting 30s/.test(n)), 'no "waiting 30s before retrying" while nothing waits');
  assert.equal(h.events[h.events.length - 1], 'notes');
});

test('N3: at Stop, a Retry-After over 20 s is waited for 20 s, not more', async () => {
  const h = mainHarness({ plan: [{ status: 429, retryAfterMs: 120000, hold: true }, { text: 'retried' }, { text: 'held' }] });
  const { done } = await inFlightAtStop(h, 82);
  const failedAt = h.now();
  await h.release(1);
  await done;
  assert.equal(h.requests.length, 3);
  const waited = h.requests[1].at - failedAt;
  assert.ok(waited >= 20000 && waited < 21000, `waited ${waited} ms`);
  assert.deepEqual(h.turns.map((x) => x.text), ['retried', 'held']);
});

// ---- N1: the whisper context prompt --------------------------------------

const http = require('http');
const { createSTT, promptWithContext, continuedText, CONTEXT_CHARS, buildVocabPrompt } = require('../src/stt');

test('N1: the prompt of a piece that starts at a cut is only the last words before it (at most 160 characters, whole words), a final "." made a ","; other pieces get the vocabulary', () => {
  assert.equal(promptWithContext('Docker, AWS', ''), 'Docker, AWS');
  assert.equal(promptWithContext('Docker, AWS', 'how you learned about our Data Pipeline team.'), 'how you learned about our Data Pipeline team,');
  assert.equal(promptWithContext('Docker, AWS', 'before the launch?'), 'before the launch?');
  assert.equal(promptWithContext('Docker, AWS', 'everyone knew the steps. Great!'), 'everyone knew the steps. Great!');
  assert.equal(promptWithContext('Docker, AWS', 'and then'), 'and then,');
  const long = 'Before we move on, I would like to hear how you learned about our Data Pipeline team, what interested you about this role, and which parts of your background you think matter.';
  const p = promptWithContext('V', long);
  assert.ok(p.length <= CONTEXT_CHARS, `prompt of ${p.length} characters`);
  assert.ok(!/Docker|^V/.test(p), 'no vocabulary list');
  const words = p.slice(0, -1);
  assert.ok(long.slice(0, -1).endsWith(words) && long[long.length - 1 - words.length - 1] === ' ', 'the tail starts at a whole word');
});

test('N1: a piece after a cut starts with a capital when the text before it ended a sentence, else as whisper wrote it', () => {
  assert.equal(continuedText('describe a situation where', 'about deadlines.'), 'Describe a situation where');
  assert.equal(continuedText('who reviewed the fix?', 'knew the steps. Great!'), 'Who reviewed the fix?');
  assert.equal(continuedText('what interested you', 'our Data Pipeline team,'), 'what interested you');
  assert.equal(continuedText('', 'Great.'), '');
});

// The publik request as sent: a local server stands in for publik.
function publikServer(answers) {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
      prompts.push(m ? Buffer.from(m[1], 'latin1').toString('utf8') : null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: answers[prompts.length - 1] || '' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, prompts, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('N1: publik gets the context in the whisper prompt only for a piece that continues a cut', async () => {
  const srv = await publikServer(['Who reviewed the fix? My lead reviewed it.', 'Great. Who reviewed the fix? My lead reviewed it.']);
  try {
    const settings = { provider: 'publik', apiKeys: { publik: 'test-publik-key' }, publik: { baseUrl: srv.url } };
    const stt = createSTT(settings);
    assert.equal(stt.providers[0], 'publik');
    S.reseed(91);
    const pcm = S.speech(1500);
    const a = await stt.transcribe(pcm);
    const ctx = 'And how long did the rollback take? About 20 minutes, because we had a script for it. Great.';
    const b = await createSTT(settings).transcribe(pcm, { context: ctx });
    const vocab = buildVocabPrompt(settings);
    assert.equal(srv.prompts[0], vocab);
    assert.equal(srv.prompts[1], ctx.replace(/\.$/, ','), 'only the words before the cut, the final "." made a ","');
    assert.equal(a.text, 'Who reviewed the fix? My lead reviewed it.');
    assert.equal(b.text, 'Great. Who reviewed the fix? My lead reviewed it.', 'a repeat of the text before is kept (round 4)');
  } finally { srv.server.close(); }
});
