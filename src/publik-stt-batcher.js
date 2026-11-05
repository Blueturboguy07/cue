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
// Why the cuts also have a time limit (verify of dcfd238): with no 600 ms
// pause (quick turns, music or steady noise above the silence level) a
// sentence reached whisper only at the 28 s cap, up to 28 s after it ended,
// and "What should I say?" could not see it.
//
// Rules, per channel. The audio is read in 30 ms frames. A frame is silence
// when its RMS is below the silence level: `gate`, or `floorRatio` times the
// noise floor (the quietest frame of the previous `floorMs`, once that much
// audio was heard) when that is higher. So steady music or noise stops
// counting as speech after `floorMs`, and quiet speech in a quiet room is
// never called silence (`gate` is the lowest level).
//   - An utterance starts at the first voiced frame (with `preRollMs` of the
//     silence before it, so the first word is not clipped).
//   - It ends at a pause: `pauseMs` of silence once it holds `minMs` of
//     audio, or `endMs` at any length (a short "Yes." followed by silence).
//     `tailMs` of the pause is kept.
//   - Once it holds `softMs`, it is cut at its next gap of `softPauseMs` (a
//     clause pause).
//   - Its first gap of `softPauseMs` (where a sentence may have ended) waits
//     at most `softDeadlineMs`: then the utterance is cut at its latest such
//     gap. So a sentence that ends in quick turns, with no long pause after
//     it, reaches whisper within about 10 s of its end.
//   - Such a cut is made only when the speech goes on for `confirmMs` after
//     the gap. When the sentence ends sooner, it is sent whole: a short tail
//     ("and what you learned from it.") alone is where whisper invents words.
//   - It never grows past `maxMs`. At the cap it is cut at the longest gap in
//     its last `lookbackMs` (else, with no gap at all, at the quietest frame
//     there). So talk with no gap at all is transcribed within about 15 s.
//   - Every cut is in the middle of a gap, and what follows the cut is held
//     as the start of the next utterance: no word is cut off and none is
//     sent twice.
//   - Fewer than `minSpeechMs` of voiced frames (a click) is dropped.
//   - One channel sends at most one request per `minGapMs`; utterances that
//     wait are merged (up to `maxMs`) and sent together.
//   - A piece whose request failed for a passing reason (busy, server error,
//     timeout) can be queued once more with `retry()`; it goes out first,
//     alone, after its delay.
//   - `flush()` returns what is held when the session stops (the sentence
//     still being spoken), so it is sent as a final piece, not dropped.
// Mac and Windows meeting audio (and the mic) reach this the same way:
// renderer PCM -> routeAudio -> 900 ms windows -> push().
const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono PCM
const FRAME_MS = 30;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 960

const DEFAULTS = {
  gate: 180,          // same as main.js RMS_GATE: the lowest silence level
  floorMs: 3000,      // the noise floor is the quietest frame of this much audio
  floorRatio: 2,      // speech is at least 6 dB above the noise floor
  minMs: 2000,
  pauseMs: 600,
  endMs: 1200,
  softMs: 8000,
  softPauseMs: 180,   // a 200 ms gap holds at least 6 whole 30 ms frames
  softDeadlineMs: 6500,
  confirmMs: 1200,    // a cut waits for this much speech after its gap
  maxMs: 14000,       // with ~1 s of whisper time: text within 15 s with no gap at all
  lookbackMs: 5000,
  preRollMs: 210,
  tailMs: 300,
  minSpeechMs: 120,   // "No." spoken quietly; a click is under 100 ms
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
    this.floorRatio = o.floorRatio;
    this.floorFrames = msToFrames(o.floorMs);
    this.minFrames = msToFrames(o.minMs);
    this.pauseFrames = msToFrames(o.pauseMs);
    this.endFrames = msToFrames(o.endMs);
    this.softFrames = msToFrames(o.softMs);
    this.softPauseFrames = Math.max(1, Math.floor(o.softPauseMs / FRAME_MS));
    this.softDeadlineFrames = msToFrames(o.softDeadlineMs);
    this.confirmFrames = Math.max(0, Math.round(o.confirmMs / FRAME_MS));
    this.maxFrames = msToFrames(o.maxMs);
    this.lookbackFrames = msToFrames(o.lookbackMs);
    this.preRollFrames = msToFrames(o.preRollMs);
    this.tailFrames = msToFrames(o.tailMs);
    this.minSpeechFrames = msToFrames(o.minSpeechMs);
    this.tickFrames = msToFrames(o.tickMs);
    this.maxBytes = this.maxFrames * FRAME_BYTES;
    this.minGapMs = o.minGapMs;
    this.now = o.now || (() => Date.now());
    this.lastSentAt = -Infinity;
    this.retried = new WeakSet(); // pieces already given their one more try
    this.reset();
  }

  /**
   * One flush tick. `pcm` is this window's raw PCM (silence included), or
   * null when no audio arrived. Returns the utterance to transcribe now, or
   * null.
   */
  push(pcm) {
    this._take(pcm);
    return this._release();
  }

  /**
   * The session stopped: `pcm` is the audio that arrived since the last
   * tick (or null). Ends the utterance in progress and returns everything
   * held, oldest first, as pieces of at most `maxMs` (no wait for
   * `minGapMs`; a retry waits for its delay in the caller). Empties the
   * batcher.
   */
  flush(pcm) {
    if (pcm && pcm.length) this._take(pcm);
    if (this.utter.length) {
      const keep = this.utter.length - this.trailing + Math.min(this.trailing, this.tailFrames);
      this._emit(this.utter.slice(0, keep));
    }
    const out = [];
    while (this.ready.length) {
      const first = this.ready.shift();
      let buf = first.buf;
      if (!first.retry) {
        while (this.ready.length && !this.ready[0].retry && buf.length + this.ready[0].buf.length <= this.maxBytes) buf = Buffer.concat([buf, this.ready.shift().buf]);
      }
      out.push(buf);
    }
    this.reset();
    return out;
  }

  /**
   * The request for `pcm` failed for a passing reason. Queue it once more,
   * first in line, after `delayMs` (and minGapMs). Returns false when it was
   * already a second try: then it is given up.
   */
  retry(pcm, delayMs = this.minGapMs) {
    if (!pcm || !pcm.length || this.retried.has(pcm)) return false;
    this.retried.add(pcm);
    this.ready.unshift({ buf: pcm, retry: true, notBefore: this.now() + Math.max(0, delayMs) });
    return true;
  }

  pendingMs() {
    const bytes = this.utter.length * FRAME_BYTES + this.ready.reduce((n, r) => n + r.buf.length, 0);
    return Math.round((bytes / BYTES_PER_SECOND) * 1000);
  }

  reset() {
    this.remainder = Buffer.alloc(0);
    this.pre = [];          // silent frames before speech (pre-roll)
    this.utter = [];        // frames of the current utterance: { buf, rms, voiced }
    this.trailing = 0;      // silent frames at the end of `utter`
    this.firstGap = -1;     // index in `utter` where its first clause gap starts
    this.lastGap = null;    // its latest clause gap: { start, length }
    this.pendingCut = null; // a cut waiting for confirmFrames: { at, finalAt }
    this.ready = [];        // finished pieces waiting for minGapMs: { buf, retry, notBefore }
    this.levels = new Float32Array(this.floorFrames); // recent frame RMS, for the noise floor
    this.levelCount = 0;
  }

  _take(pcm) {
    if (pcm && pcm.length) {
      const all = this.remainder.length ? Buffer.concat([this.remainder, pcm]) : pcm;
      let off = 0;
      for (; off + FRAME_BYTES <= all.length; off += FRAME_BYTES) this._frame(all.subarray(off, off + FRAME_BYTES));
      this.remainder = Buffer.from(all.subarray(off));
    } else {
      for (let i = 0; i < this.tickFrames; i++) this._frame(null);
    }
  }

  // The silence level for this frame: the gate, or floorRatio times the
  // quietest of the previous floorFrames frames once there are that many.
  _silenceLevel(rms) {
    let level = this.gate;
    if (this.levelCount >= this.floorFrames && this.floorRatio > 0) {
      let floor = Infinity;
      for (let i = 0; i < this.floorFrames; i++) if (this.levels[i] < floor) floor = this.levels[i];
      level = Math.max(level, floor * this.floorRatio);
    }
    this.levels[this.levelCount % this.floorFrames] = rms;
    this.levelCount++;
    return level;
  }

  _frame(buf) {
    const rms = buf ? frameRms(buf) : 0;
    const f = { buf: buf ? Buffer.from(buf) : Buffer.alloc(FRAME_BYTES), rms, voiced: rms >= this._silenceLevel(rms) };
    if (!this.utter.length) {
      if (!f.voiced) {
        this.pre.push(f);
        if (this.pre.length > this.preRollFrames) this.pre.shift();
        return;
      }
      this.utter = this.pre.concat(f);
      this.pre = [];
      this.trailing = 0;
      this.firstGap = -1;
      this.lastGap = null;
      this.pendingCut = null;
      return;
    }
    this.utter.push(f);
    if (f.voiced) {
      const gap = this.trailing;
      this.trailing = 0;
      if (gap >= this.softPauseFrames) {
        const start = this.utter.length - 1 - gap;
        this._noteGap(start, gap);
        // A clause gap once the utterance holds softMs: cut in its middle.
        if (start >= this.softFrames && !this.pendingCut) this._planCut(start, gap);
      }
    } else this.trailing++;

    const len = this.utter.length;
    const ended = this.trailing >= this.endFrames ||
      (len >= this.minFrames && this.trailing >= this.pauseFrames);
    if (ended) {
      // Also when a cut was waiting: the sentence ended soon after its gap,
      // so it goes whole (no short tail on its own for whisper).
      const keep = len - this.trailing + Math.min(this.trailing, this.tailFrames);
      const rest = this.utter.slice(keep);
      this._emit(this.utter.slice(0, keep));
      this.utter = [];
      this.trailing = 0;
      this.firstGap = -1;
      this.lastGap = null;
      this.pendingCut = null;
      this.pre = rest.slice(-this.preRollFrames);
      return;
    }
    if (!this.pendingCut && this.firstGap >= 0 && len - this.firstGap >= this.softDeadlineFrames) {
      this._planCut(this.lastGap.start, this.lastGap.length);
    }
    // A planned cut is made once the speech has gone on for confirmFrames
    // after its gap, at a voiced frame (a pause in progress may still turn
    // out to be the end of the sentence).
    if (this.pendingCut && len >= this.pendingCut.finalAt && f.voiced) {
      this._cutAt(this.pendingCut.at);
      return;
    }
    if (len >= this.maxFrames) this._forcedCut();
  }

  // Plan a cut in the middle of the gap at [start, start + length).
  _planCut(start, length) {
    this.pendingCut = { at: start + Math.floor(length / 2), finalAt: start + length + this.confirmFrames };
  }

  _noteGap(start, length) {
    if (start <= 0) return; // silence before any speech is not a gap
    if (this.firstGap < 0) this.firstGap = start;
    this.lastGap = { start, length };
  }

  // Send utter[0, cut) and hold the rest as the start of the next utterance.
  _cutAt(cut) {
    const len = this.utter.length;
    cut = Math.max(1, Math.min(cut, len - 1));
    this.pendingCut = null;
    const held = this.utter.slice(cut);
    this._emit(this.utter.slice(0, cut));
    this.utter = held;
    // Find the clause gaps and the trailing silence again in what is held.
    this.firstGap = -1;
    this.lastGap = null;
    let run = 0;
    let seenVoice = false;
    for (let i = 0; i < held.length; i++) {
      if (held[i].voiced) {
        if (seenVoice && run >= this.softPauseFrames) this._noteGap(i - run, run);
        seenVoice = true;
        run = 0;
      } else run++;
    }
    this.trailing = run;
  }

  // At the cap: cut at the middle of the longest gap in the last
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
    this._cutAt(cut);
  }

  _emit(frames) {
    const voiced = frames.filter((f) => f.voiced).length;
    if (voiced < this.minSpeechFrames) return; // a click, not speech
    this.ready.push({ buf: Buffer.concat(frames.map((f) => f.buf)), retry: false, notBefore: 0 });
  }

  _release() {
    if (!this.ready.length) return null;
    const t = this.now();
    if (t - this.lastSentAt < this.minGapMs) return null;
    const first = this.ready[0];
    if (first.retry && t < first.notBefore) return null; // keeps the order: nothing passes it
    this.ready.shift();
    let out = first.buf;
    if (!first.retry) {
      while (this.ready.length && !this.ready[0].retry && out.length + this.ready[0].buf.length <= this.maxBytes) out = Buffer.concat([out, this.ready.shift().buf]);
    }
    this.lastSentAt = t;
    return out;
  }
}

module.exports = { UtteranceBatcher, DEFAULTS, DEFAULT_MAX_MS, DEFAULT_MIN_GAP_MS, BYTES_PER_SECOND, FRAME_MS, FRAME_BYTES, frameRms };
