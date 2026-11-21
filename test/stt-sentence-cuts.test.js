// Meeting audio is cut at pauses, not at a fixed 8 s (0.2.11 smoke test:
// "How did you learn about pipeline?" on the Mac and "…a time when you were
// in the cloud." on Windows were whisper-1 inventions at an 8 s cut).
// Synthetic PCM (test/stt-synth.js): "syllables" of tone (180 ms) with 60 ms
// gaps between them, as in speech, and pauses of low noise between
// sentences. It is fed in the 900 ms windows main.js flushes.
const assert = require('node:assert/strict');
const test = require('node:test');
const { readSource } = require('./source-text');
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');
const { GATE, pause, speech, rms, ms, at } = require('./stt-synth');

// Feed a recording in 900 ms windows; collect what is sent and when.
function run(parts, opts = {}) {
  const audio = Buffer.concat(parts);
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t, ...opts });
  const sent = [];
  const win = (900 / 1000) * BYTES_PER_SECOND;
  for (let off = 0; off < audio.length; off += win) {
    t += 900;
    const out = b.push(audio.subarray(off, Math.min(off + win, audio.length)));
    if (out) sent.push({ at: t, pcm: out });
  }
  for (let i = 0; i < 6; i++) { t += 900; const out = b.push(null); if (out) sent.push({ at: t, pcm: out }); }
  return { audio, sent };
}
const startsSilent = (p) => rms(p.subarray(0, 960)) < GATE;
const endsSilent = (p) => rms(p.subarray(p.length - 960)) < GATE;

test('a long question (18 s) with only the short gaps between syllables is never cut at 8 s inside a word: one cut, in a gap, at the 14 s cap', () => {
  const { audio, sent } = run([pause(990), speech(18000), pause(2400)]);
  assert.equal(sent.length, 2, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(ms(sent[0].pcm) > 10000 && ms(sent[0].pcm) <= 14000, `first piece ${ms(sent[0].pcm)} ms`);
  assert.ok(endsSilent(sent[0].pcm) && startsSilent(sent[1].pcm), 'the cut is in a gap between syllables');
  // 210 ms of the silence before it, the whole question, 300 ms of the pause after: once, in order.
  assert.ok(Buffer.concat(sent.map((s) => s.pcm)).equals(audio.subarray(at(990 - 210), at(990 + 18000 + 300))), 'nothing lost or added');
});

test('a clause pause (330 ms) after 8 s is where a long question is cut: the middle of the pause, nothing lost', () => {
  const { audio, sent } = run([pause(990), speech(9000), pause(330), speech(9000), pause(2400)]);
  assert.equal(sent.length, 2, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(endsSilent(sent[0].pcm) && startsSilent(sent[1].pcm), 'cut inside the pause');
  const cut = 990 - 210 + ms(sent[0].pcm);
  assert.ok(cut > 990 + 9000 && cut < 990 + 9330, `cut at ${cut} ms, the pause is 9990-10320 ms`);
  assert.ok(Buffer.concat(sent.map((s) => s.pcm)).equals(audio.subarray(at(990 - 210), at(990 + 18330 + 300))));
});

test('a short question with a clause pause before 8 s stays whole', () => {
  const { audio, sent } = run([pause(990), speech(3990), pause(330), speech(3000), pause(2400)]);
  assert.equal(sent.length, 1, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(sent[0].pcm.equals(audio.subarray(at(990 - 210), at(990 + 7320 + 300))));
});

test('two sentences are cut at the pause between them, never inside a word', () => {
  const s1 = 990; const s2 = s1 + 6000 + 690;
  const { audio, sent } = run([pause(990), speech(6000), pause(690), speech(5010), pause(2400)]);
  assert.equal(sent.length, 2, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(sent[0].pcm.equals(audio.subarray(at(s1 - 210), at(s1 + 6000 + 300))));
  assert.ok(sent[1].pcm.equals(audio.subarray(at(s2 - 210), at(s2 + 5010 + 300))));
  for (const s of sent) assert.ok(startsSilent(s.pcm) && endsSilent(s.pcm), 'starts and ends in silence');
});

test('40 s of talk with no clause pause: pieces of at most 14 s, each cut in a gap between syllables; the tail is held, no word lost or sent twice', () => {
  const start = 990; const end = start + 40020;
  const { audio, sent } = run([pause(990), speech(40020), pause(2400)]);
  assert.ok(sent.length >= 3, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  for (const s of sent) assert.ok(s.pcm.length <= 14000 / 1000 * BYTES_PER_SECOND, `a piece of ${ms(s.pcm)} ms: a whisper request holds at most 14 s`);
  for (let i = 1; i < sent.length; i++) assert.ok(endsSilent(sent[i - 1].pcm) && startsSilent(sent[i].pcm), `cut ${i} is in a gap`);
  assert.ok(Buffer.concat(sent.map((s) => s.pcm)).equals(audio.subarray(at(start - 210), at(end + 300))), 'together: the whole talk once');
});

test('a click (60 ms) is not sent to whisper', () => {
  const { sent } = run([pause(990), speech(60, { gaps: false }), pause(3000)]);
  assert.equal(sent.length, 0);
});

test('a short answer ("Yes.") followed by silence is sent on its own', () => {
  const { sent } = run([pause(990), speech(480), pause(3000), speech(3000), pause(2400)]);
  assert.equal(sent.length, 2);
  assert.ok(ms(sent[0].pcm) < 1200, `"Yes." was ${ms(sent[0].pcm)} ms`);
});

test('main.js gives the batcher the raw window (pauses included), the same on Mac and Windows', () => {
  const src = readSource('main.js');
  assert.match(src, /pcm = publikSttBatchers\[channel\]\.push\(windowPcm\);/);
  // Both platforms' meeting audio and the mic take the same road into flushChannel.
  assert.match(src, /ipcMain\.on\('system:pcm', \(_e, arrayBuffer\) => \{ if \(state\.capturing\) routeAudio\('them', arrayBuffer\); \}\);/);
  assert.match(src, /ipcMain\.on\('mic:pcm', \(_e, arrayBuffer\) => \{ if \(state\.capturing\) routeAudio\('you', arrayBuffer\); \}\);/);
  const gate = Number((src.match(/const RMS_GATE = (\d+);/) || [])[1]);
  assert.equal(new UtteranceBatcher().gate, gate, 'the batcher\'s lowest silence level is main.js RMS_GATE');
});
