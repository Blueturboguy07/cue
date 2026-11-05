// Groups meeting audio into whole utterances, cut at pauses, before they go
// to publik API for transcription (whisper-1).
//
// Why batch: main.js flushes each channel every 900 ms. Sent one by one, two
// busy channels make up to ~130 transcription requests a minute, and a publik
// key is limited to 60 requests a minute (chat included). Whole utterances
// are also transcribed far better than fragments.
//
// Why cut at pauses (0.2.11 smoke test): the old batcher sent a fixed 8 s of
// continuous speech, so a question longer than 8 s was cut mid-sentence and
// whisper-1 invented words at the cut ("How did you learn about pipeline?",
// "…a time when you were in the cloud."), which "What should I say?" then
// answered. A 900 ms window is "silent" only when the whole window is quiet,
// so the short pauses between phrases never ended an utterance.
//
// Rules, per channel. The audio is read in 30 ms frames; a frame whose RMS is
// below `gate` is silence.
//   - An utterance starts at the first voiced frame (with `preRollMs` of the
//     silence before it, so the first word is not clipped).
//   - It ends at a pause: `pauseMs` of silence once it holds `minMs` of
//     audio, or `endMs` at any length (a short "Yes." followed by silence).
//     `tailMs` of the pause is kept. A comma is shorter than `pauseMs`, so a
//     sentence is not cut at its commas (the smoke test's invented words came
//     from a short tail such as "and what you learned from it").
//   - It never grows past `maxMs` (whisper request size and how fast the
//     suggestion can appear). At the cap it is cut at the longest pause in
//     its last `lookbackMs` (else at the quietest frame there), and the rest
//     is held as the start of the next utterance: no word is cut off and
//     none is sent twice.
//   - Fewer than `minSpeechMs` of voiced frames (a click, a cough) is dropped.
//   - One channel sends at most one request per `minGapMs`; utterances that
//     wait are merged (up to `maxMs`) and sent together.
// Mac and Windows meeting audio (and the mic) reach this the same way:
// renderer PCM -> routeAudio -> 900 ms windows -> push().
const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono PCM
const FRAME_MS = 30;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 960

const DEFAULTS = {
  gate: 180,          // same as main.js RMS_GATE
  minMs: 2000,
  pauseMs: 600,
  endMs: 1200,
  maxMs: 28000,
  lookbackMs: 8000,
  preRollMs: 210,
  tailMs: 300,
  minSpeechMs: 300,
  minGapMs: 2500,
  tickMs: 900         // a window with no audio at all counts as this much silence
};
const DEFAULT_MAX_MS = DEFAULTS.maxMs;
const DEFAULT_MIN_GAP_MS = DEFAULTS.minGapMs;

function frameRms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

const msToFrames = (ms) => Math.max(1, Math.round(ms / FRAME_MS));

class UtteranceBatcher {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.gate = o.gate;
    this.minFrames = msToFrames(o.minMs);
    this.pauseFrames = msToFrames(o.pauseMs);
    this.endFrames = msToFrames(o.endMs);
    this.maxFrames = msToFrames(o.maxMs);
    this.lookbackFrames = msToFrames(o.lookbackMs);
    this.preRollFrames = msToFrames(o.preRollMs);
    this.tailFrames = msToFrames(o.tailMs);
    this.minSpeechFrames = msToFrames(o.minSpeechMs);
    this.tickFrames = msToFrames(o.tickMs);
    this.maxBytes = this.maxFrames * FRAME_BYTES;
    this.minGapMs = o.minGapMs;
    this.now = o.now || (() => Date.now());
    this.lastSentAt = 0;
    this.reset();
  }

  /**
   * One flush tick. `pcm` is this window's raw PCM (silence included), or
   * null when no audio arrived. Returns the utterance to transcribe now, or
   * null.
   */
  push(pcm) {
    if (pcm && pcm.length) {
      const all = this.remainder.length ? Buffer.concat([this.remainder, pcm]) : pcm;
      let off = 0;
      for (; off + FRAME_BYTES <= all.length; off += FRAME_BYTES) this._frame(all.subarray(off, off + FRAME_BYTES));
      this.remainder = Buffer.from(all.subarray(off));
    } else {
      for (let i = 0; i < this.tickFrames; i++) this._frame(null);
    }
    return this._release();
  }

  pendingMs() {
    const frames = this.utter.length + this.ready.reduce((n, b) => n + b.length / FRAME_BYTES, 0);
    return frames * FRAME_MS;
  }

  reset() {
    this.remainder = Buffer.alloc(0);
    this.pre = [];          // silent frames before speech (pre-roll)
    this.utter = [];        // frames of the current utterance: { buf, rms, voiced }
    this.trailing = 0;      // silent frames at the end of `utter`
    this.voicedFrames = 0;  // voiced frames in `utter`
    this.ready = [];        // finished utterances waiting for minGapMs
  }

  _frame(buf) {
    const rms = buf ? frameRms(buf) : 0;
    const f = { buf: buf ? Buffer.from(buf) : Buffer.alloc(FRAME_BYTES), rms, voiced: rms >= this.gate };
    if (!this.utter.length) {
      if (!f.voiced) {
        this.pre.push(f);
        if (this.pre.length > this.preRollFrames) this.pre.shift();
        return;
      }
      this.utter = this.pre.concat(f);
      this.pre = [];
      this.trailing = 0;
      this.voicedFrames = 1;
      return;
    }
    this.utter.push(f);
    if (f.voiced) { this.trailing = 0; this.voicedFrames++; } else this.trailing++;

    const len = this.utter.length;
    const ended = this.trailing >= this.endFrames ||
      (len >= this.minFrames && this.trailing >= this.pauseFrames);
    if (ended) {
      const keep = len - this.trailing + Math.min(this.trailing, this.tailFrames);
      const rest = this.utter.slice(keep);
      this._emit(this.utter.slice(0, keep));
      this.utter = [];
      this.trailing = 0;
      this.voicedFrames = 0;
      this.pre = rest.slice(-this.preRollFrames);
      return;
    }
    if (len >= this.maxFrames) this._forcedCut();
  }

  // At the cap: cut at the middle of the longest pause in the last
  // lookbackFrames, else at the quietest frame there; hold the rest.
  _forcedCut() {
    const len = this.utter.length;
    const from = Math.max(1, len - this.lookbackFrames);
    let best = { start: -1, length: 0 };
    let runStart = -1;
    for (let i = from; i < len; i++) {
      if (!this.utter[i].voiced) {
        if (runStart < 0) runStart = i;
        const runLen = i - runStart + 1;
        if (runLen >= best.length) best = { start: runStart, length: runLen };
      } else runStart = -1;
    }
    let cut;
    if (best.length) cut = best.start + Math.floor(best.length / 2);
    else {
      cut = from;
      for (let i = from; i < len; i++) if (this.utter[i].rms <= this.utter[cut].rms) cut = i;
    }
    cut = Math.max(1, Math.min(cut, len - 1));
    const held = this.utter.slice(cut);
    this._emit(this.utter.slice(0, cut));
    this.utter = held;
    this.voicedFrames = held.filter((f) => f.voiced).length;
    let t = 0;
    for (let i = held.length - 1; i >= 0 && !held[i].voiced; i--) t++;
    this.trailing = t;
  }

  _emit(frames) {
    const voiced = frames.filter((f) => f.voiced).length;
    if (voiced < this.minSpeechFrames) return; // a click or a cough, not speech
    this.ready.push(Buffer.concat(frames.map((f) => f.buf)));
  }

  _release() {
    if (!this.ready.length) return null;
    const t = this.now();
    if (t - this.lastSentAt < this.minGapMs) return null;
    let out = this.ready.shift();
    while (this.ready.length && out.length + this.ready[0].length <= this.maxBytes) out = Buffer.concat([out, this.ready.shift()]);
    this.lastSentAt = t;
    return out;
  }
}

module.exports = { UtteranceBatcher, DEFAULTS, DEFAULT_MAX_MS, DEFAULT_MIN_GAP_MS, BYTES_PER_SECOND, FRAME_MS, FRAME_BYTES, frameRms };
