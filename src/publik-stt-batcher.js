// Groups the batch loop's ~900 ms audio windows into utterances before they
// go to publik API for transcription.
//
// Why: main.js flushes each channel every 900 ms. Sent one by one, two busy
// channels make up to ~130 transcription requests a minute, and a publik key
// is limited to 60 requests a minute (chat included), so listening would stop
// on a 429 within a minute. Whole utterances are also transcribed far better
// than 0.9 s fragments cut mid-word.
//
// Rules, per channel:
//   - a voiced window is added to the pending utterance;
//   - a silent window ends the utterance: it is sent, unless the last send on
//     this channel was less than `minGapMs` ago (then it waits a tick);
//   - an utterance that reaches `maxBytes` is sent at once.
// So one channel sends at most one request per `minGapMs` while people pause,
// and one per `maxBytes` of audio while someone talks without a pause.
const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono PCM
const DEFAULT_MAX_MS = 8000;
const DEFAULT_MIN_GAP_MS = 2500;

class UtteranceBatcher {
  constructor({ maxMs = DEFAULT_MAX_MS, minGapMs = DEFAULT_MIN_GAP_MS, now = () => Date.now() } = {}) {
    this.maxBytes = Math.round((maxMs / 1000) * BYTES_PER_SECOND);
    this.minGapMs = minGapMs;
    this.now = now;
    this.chunks = [];
    this.bytes = 0;
    this.lastSentAt = 0;
  }

  /**
   * One flush tick. `voiced` is this window's PCM when it passed the silence
   * gate, else null. Returns the utterance to transcribe now, or null.
   */
  push(voiced) {
    if (voiced && voiced.length) { this.chunks.push(voiced); this.bytes += voiced.length; }
    if (!this.bytes) return null;
    const full = this.bytes >= this.maxBytes;
    const ended = !voiced || !voiced.length;
    if (!full && !ended) return null;
    const t = this.now();
    if (!full && t - this.lastSentAt < this.minGapMs) return null;
    const out = Buffer.concat(this.chunks);
    this.chunks = []; this.bytes = 0; this.lastSentAt = t;
    return out;
  }

  pendingMs() { return Math.round((this.bytes / BYTES_PER_SECOND) * 1000); }

  reset() { this.chunks = []; this.bytes = 0; }
}

module.exports = { UtteranceBatcher, DEFAULT_MAX_MS, DEFAULT_MIN_GAP_MS, BYTES_PER_SECOND };
