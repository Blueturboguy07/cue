// Meeting audio is cut at pauses, not at a fixed 8 s (0.2.11 smoke test:
// "How did you learn about pipeline?" on the Mac and "…a time when you were
// in the cloud." on Windows were whisper-1 inventions at an 8 s cut).
// Synthetic PCM: "syllables" of tone (180 ms) with 60 ms gaps between them,
// as in speech, and pauses of low noise between sentences. It is fed in the
// 900 ms windows main.js flushes.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');

const RATE = 16000;
const FRAME = 480; // samples in 30 ms
const GATE = 180;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

function frames(n, fill) {
  const buf = Buffer.alloc(n * FRAME * 2);
  for (let f = 0; f < n; f++) for (let i = 0; i < FRAME; i++) buf.writeInt16LE(Math.round(fill(f, i)), (f * FRAME + i) * 2);
  return buf;
}
// Low room noise: RMS about 23, under the gate.
const pause = (ms) => frames(ms / 30, () => rnd() * 80);
// Speech: 6 voiced frames (a syllable, each with its own pitch) and 2 quiet
// frames. The last syllable is voiced to its end, so the speech ends at `ms`.
function speech(ms, { gaps = true } = {}) {
  const n = ms / 30;
  return frames(n, (f, i) => {
    const pos = f % 8;
    if (gaps && pos >= 6 && f < n - 8) return rnd() * 80;
    const freq = 140 + ((f >> 3) % 23) * 9;
    return 5000 * Math.sin(2 * Math.PI * freq * ((f * FRAME + i) / RATE)) + rnd() * 400;
  });
}
const rms = (buf) => { let s = 0; const n = buf.length / 2; for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / n); };
const ms = (buf) => Math.round((buf.length / BYTES_PER_SECOND) * 1000);

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
const at = (msOffset) => (msOffset / 1000) * BYTES_PER_SECOND;

test('a long question (18 s) with no long pause is sent whole, not cut at 8 s', () => {
  const { audio, sent } = run([pause(990), speech(18000), pause(2400)]);
  assert.equal(sent.length, 1, `sent ${sent.length} pieces: ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  // 210 ms of the silence before it, the whole question, 300 ms of the pause after.
  assert.ok(sent[0].pcm.equals(audio.subarray(at(990 - 210), at(990 + 18000 + 300))), 'exactly the question, nothing lost or added');
  const speechEnd = 990 + 18000;
  assert.ok(sent[0].at - speechEnd <= 1500, `sent ${sent[0].at - speechEnd} ms after the speaker stopped`);
});

test('a comma pause (330 ms) inside a long question does not cut it', () => {
  const { audio, sent } = run([pause(990), speech(9000), pause(330), speech(9000), pause(2400)]);
  assert.equal(sent.length, 1, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(sent[0].pcm.equals(audio.subarray(at(990 - 210), at(990 + 18330 + 300))));
});

test('two sentences are cut at the pause between them, never inside a word', () => {
  const s1 = 990; const s2 = s1 + 6000 + 690;
  const { audio, sent } = run([pause(990), speech(6000), pause(690), speech(5010), pause(2400)]);
  assert.equal(sent.length, 2, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(sent[0].pcm.equals(audio.subarray(at(s1 - 210), at(s1 + 6000 + 300))));
  assert.ok(sent[1].pcm.equals(audio.subarray(at(s2 - 210), at(s2 + 5010 + 300))));
  for (const s of sent) {
    assert.ok(rms(s.pcm.subarray(0, 960)) < GATE, 'starts in silence');
    assert.ok(rms(s.pcm.subarray(s.pcm.length - 960)) < GATE, 'ends in silence');
  }
});

test('40 s of talk with no pause: cut at the hard cap in a gap between words; the tail is held, no word lost or sent twice', () => {
  const start = 990; const end = start + 40020;
  const { audio, sent } = run([pause(990), speech(40020), pause(2400)]);
  assert.equal(sent.length, 2, `sent ${sent.map((s) => ms(s.pcm)).join(', ')} ms`);
  assert.ok(ms(sent[0].pcm) <= 28000 && ms(sent[0].pcm) >= 20000, `first piece ${ms(sent[0].pcm)} ms`);
  assert.ok(rms(sent[0].pcm.subarray(sent[0].pcm.length - 960)) < GATE, 'the cut is in a gap between words');
  assert.ok(rms(sent[1].pcm.subarray(0, 960)) < GATE, 'the held tail starts in that gap');
  assert.ok(Buffer.concat(sent.map((s) => s.pcm)).equals(audio.subarray(at(start - 210), at(end + 300))), 'together: the whole talk once');
  for (const s of sent) assert.ok(s.pcm.length <= 28000 / 1000 * BYTES_PER_SECOND, 'a whisper request holds at most 28 s (896 KB)');
});

test('continuous sound with no gap at all is still capped at 28 s and sent once, in order', () => {
  const start = 990; const end = start + 35010;
  const { audio, sent } = run([pause(990), speech(35010, { gaps: false }), pause(2400)]);
  assert.equal(sent.length, 2);
  assert.ok(ms(sent[0].pcm) <= 28000 && ms(sent[0].pcm) >= 20000, `first piece ${ms(sent[0].pcm)} ms`);
  assert.ok(Buffer.concat(sent.map((s) => s.pcm)).equals(audio.subarray(at(start - 210), at(end + 300))));
});

test('a click or a cough (60 ms) is not sent to whisper', () => {
  const { sent } = run([pause(990), speech(60, { gaps: false }), pause(3000)]);
  assert.equal(sent.length, 0);
});

test('a short answer ("Yes.") followed by silence is sent on its own', () => {
  const { sent } = run([pause(990), speech(480), pause(3000), speech(3000), pause(2400)]);
  assert.equal(sent.length, 2);
  assert.ok(ms(sent[0].pcm) < 1200, `"Yes." was ${ms(sent[0].pcm)} ms`);
});

test('main.js gives the batcher the raw window (pauses included), the same on Mac and Windows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /pcm = publikSttBatchers\[channel\]\.push\(windowPcm\);/);
  // Both platforms' meeting audio and the mic take the same road into flushChannel.
  assert.match(src, /ipcMain\.on\('system:pcm', \(_e, arrayBuffer\) => \{ if \(state\.capturing\) routeAudio\('them', arrayBuffer\); \}\);/);
  assert.match(src, /ipcMain\.on\('mic:pcm', \(_e, arrayBuffer\) => \{ if \(state\.capturing\) routeAudio\('you', arrayBuffer\); \}\);/);
  const gate = Number((src.match(/const RMS_GATE = (\d+);/) || [])[1]);
  assert.equal(new UtteranceBatcher().gate, gate, 'the batcher\'s silence gate is main.js RMS_GATE');
});
