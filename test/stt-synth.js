// Synthetic meeting audio for the transcription batcher tests, and a driver
// that feeds it the way main.js does. (Not a test file: the test glob is
// test/*.test.js.)
//
// Speech: "syllables" of tone (180 ms, each with its own pitch) with 60 ms
// gaps between them, as in speech. Pauses: low room noise (RMS about 23,
// under the 180 gate). A bed (music or steady noise) can be laid over the
// whole recording.
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');

const RATE = 16000;
const FRAME = 480; // samples in 30 ms
const GATE = 180;

function makeRnd(seed = 12345) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
}
let rnd = makeRnd();
const reseed = (seed) => { rnd = makeRnd(seed); };

function frames(n, fill) {
  const buf = Buffer.alloc(n * FRAME * 2);
  for (let f = 0; f < n; f++) for (let i = 0; i < FRAME; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fill(f, i)))), (f * FRAME + i) * 2);
  return buf;
}
const pause = (ms) => frames(Math.ceil(ms / 30), () => rnd() * 80);
// `amp` 5000 is normal speech; 600 is quiet speech (about -33 dBFS).
function speech(ms, { gaps = true, amp = 5000 } = {}) {
  const n = Math.ceil(ms / 30);
  return frames(n, (f, i) => {
    const pos = f % 8;
    if (gaps && pos >= 6 && f < n - 8) return rnd() * 80;
    const freq = 140 + ((f >> 3) % 23) * 9;
    return amp * Math.sin(2 * Math.PI * freq * ((f * FRAME + i) / RATE)) + rnd() * 400;
  });
}
const rms = (buf) => { let s = 0; const n = buf.length / 2; for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / n); };
const ms = (buf) => Math.round((buf.length / BYTES_PER_SECOND) * 1000);
const at = (msOffset) => Math.round((msOffset / 1000) * BYTES_PER_SECOND / 2) * 2;

// A music-like bed (three tones, a 2 Hz swell; RMS 160-270 at amp 330) and
// steady noise (uniform, RMS `level`), both above the 180 gate.
const music = (amp = 330) => (k) => { const t = k / RATE; const env = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * 2 * t)); return amp * env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t)); };
const noise = (level = 190) => () => rnd() * level * Math.sqrt(12);

// parts: [{ pcm, label? }]. Returns the audio (with the bed added) and the
// labelled parts' byte ranges.
function compose(parts, bed = null) {
  const audio = Buffer.concat(parts.map((p) => p.pcm));
  if (bed) for (let k = 0; k < audio.length / 2; k++) audio.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio.readInt16LE(k * 2) + bed(k)))), k * 2);
  const marks = []; let off = 0;
  for (const p of parts) { if (p.label) marks.push({ label: p.label, start: off, end: off + p.pcm.length }); off += p.pcm.length; }
  return { audio, marks };
}

// main.js: the renderer delivers 4096-sample chunks every 256 ms; flushChannel
// runs every 900 ms and returns at once while a transcription is in flight
// (`sttMs`), so the chunks wait and the next window is bigger.
function drive(audio, { sttMs = 1200, extraMs = 8000, opts = {} } = {}) {
  const CHUNK = 8192; const chunkMs = (CHUNK / BYTES_PER_SECOND) * 1000;
  let t = 0;
  const b = new UtteranceBatcher({ now: () => t, ...opts });
  const sends = []; let off = 0; let waiting = []; let busyUntil = -1;
  const audioMs = (audio.length / BYTES_PER_SECOND) * 1000;
  for (let tt = 900; tt <= audioMs + extraMs; tt += 900) {
    while (off + CHUNK <= audio.length && ((off + CHUNK) / CHUNK) * chunkMs <= tt) { waiting.push(audio.subarray(off, off + CHUNK)); off += CHUNK; }
    t = tt;
    if (tt < busyUntil) continue;
    const win = waiting.length ? Buffer.concat(waiting) : null; waiting = [];
    const pcm = b.push(win);
    if (pcm) { sends.push({ t: tt, textAt: tt + sttMs, pcm }); busyUntil = tt + sttMs; }
  }
  return { sends, batcher: b, delivered: off };
}

// Which send holds the audio at byte `pos` (64-byte blocks are unique: the
// signal carries noise). Returns the send's index or -1.
function sendHolding(audio, sends, pos) {
  const key = audio.toString('base64', pos - (pos % 64), pos - (pos % 64) + 64);
  for (let i = 0; i < sends.length; i++) {
    const p = sends[i].pcm;
    for (let o = 0; o + 64 <= p.length; o += 64) if (p.toString('base64', o, o + 64) === key) return i;
  }
  return -1;
}

// For each labelled part: when the send holding its last syllable went out
// and when its text came back, in ms after the part ended.
function delays(audio, marks, sends) {
  return marks.map((m) => {
    const i = sendHolding(audio, sends, m.end - 640);
    const endMs = (m.end / BYTES_PER_SECOND) * 1000;
    return { label: m.label, send: i, sentAfterEnd: i < 0 ? null : Math.round(sends[i].t - endMs), textAfterEnd: i < 0 ? null : Math.round(sends[i].textAt - endMs) };
  });
}

module.exports = { RATE, FRAME, GATE, reseed, rnd: () => rnd(), frames, pause, speech, rms, ms, at, music, noise, compose, drive, sendHolding, delays, BYTES_PER_SECOND };
