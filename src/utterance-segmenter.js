const { AdaptiveVAD, AudioRingBuffer } = require('./vad');

const DEFAULT_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;
const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_MIN_UTTERANCE_MS = 180;
// Cap each utterance at 12s so long stretches of speech transcribe and appear
// in parts as they happen instead of one big block much later; overlapMs keeps
// a word that straddles the cut from being lost.
const DEFAULT_MAX_UTTERANCE_MS = 12000;
const DEFAULT_OVERLAP_MS = 300;

class UtteranceSegmenter {
  /** Segment one PCM channel into bounded utterances without writing audio to disk. */
  constructor({
    channel,
    sampleRate = DEFAULT_SAMPLE_RATE,
    preRollMs = DEFAULT_PRE_ROLL_MS,
    minUtteranceMs = DEFAULT_MIN_UTTERANCE_MS,
    maxUtteranceMs = DEFAULT_MAX_UTTERANCE_MS,
    overlapMs = DEFAULT_OVERLAP_MS,
    vadOptions = {},
    onSpeechState = () => {},
    onUtterance = () => {}
  }) {
    if (!channel) throw new Error('UtteranceSegmenter requires a channel.');
    this.channel = channel;
    this.sampleRate = sampleRate;
    this.minimumBytes = this._millisecondsToBytes(minUtteranceMs);
    this.maximumBytes = this._millisecondsToBytes(maxUtteranceMs);
    this.overlapBytes = this._millisecondsToBytes(overlapMs);
    this.onSpeechState = onSpeechState;
    this.onUtterance = onUtterance;
    this.ringBuffer = new AudioRingBuffer(preRollMs, sampleRate);
    this.utteranceChunks = [];
    this.utteranceBytes = 0;
    this.collecting = false;
    this.startedDuringPush = false;
    this.endedDuringPush = false;

    this.vad = new AdaptiveVAD({
      sampleRate,
      ...vadOptions,
      onSpeechStart: () => this._beginUtterance(),
      onSpeechEnd: (durationMs) => this._requestUtteranceEnd(durationMs)
    });
  }

  push(pcm) {
    const chunk = Buffer.from(pcm || []);
    if (chunk.length < PCM_BYTES_PER_SAMPLE) return;
    if (chunk.length % PCM_BYTES_PER_SAMPLE !== 0) {
      throw new Error('PCM chunks must contain complete 16-bit samples.');
    }

    this.startedDuringPush = false;
    this.endedDuringPush = false;
    const wasCollecting = this.collecting;

    if (!wasCollecting) this.ringBuffer.write(chunk);
    this.vad.processChunk(chunk);

    // A chunk that triggered speech start is already present in the pre-roll.
    if (wasCollecting) this._appendChunk(chunk);
    if (this.endedDuringPush) this._finalizeUtterance();
  }

  stop() {
    if (this.collecting) this._finalizeUtterance();
    this.reset();
  }

  reset() {
    this.collecting = false;
    this.startedDuringPush = false;
    this.endedDuringPush = false;
    this.utteranceChunks = [];
    this.utteranceBytes = 0;
    this.ringBuffer.clear();
    this.vad.reset();
  }

  _beginUtterance() {
    this.collecting = true;
    this.startedDuringPush = true;
    const preRoll = this.ringBuffer.read();
    this.utteranceChunks = preRoll.length ? [Buffer.from(preRoll)] : [];
    this.utteranceBytes = preRoll.length;
    this.ringBuffer.clear();
    this.onSpeechState(this.channel, true);
  }

  _requestUtteranceEnd(durationMs) {
    this.endedDuringPush = true;
    this.onSpeechState(this.channel, false, durationMs);
  }

  // Time O(n), space O(n) at each 25-second boundary; regular pushes are O(1).
  _appendChunk(chunk) {
    this.utteranceChunks.push(chunk);
    this.utteranceBytes += chunk.length;

    while (this.utteranceBytes >= this.maximumBytes) {
      const combined = Buffer.concat(this.utteranceChunks, this.utteranceBytes);
      this._emit(combined.subarray(0, this.maximumBytes));
      const nextStart = Math.max(0, this.maximumBytes - this.overlapBytes);
      const remainder = Buffer.from(combined.subarray(nextStart));
      this.utteranceChunks = remainder.length ? [remainder] : [];
      this.utteranceBytes = remainder.length;
    }
  }

  _finalizeUtterance() {
    if (!this.collecting) return;
    const utterance = Buffer.concat(this.utteranceChunks, this.utteranceBytes);
    if (utterance.length >= this.minimumBytes) this._emit(utterance);
    this.collecting = false;
    this.endedDuringPush = false;
    this.utteranceChunks = [];
    this.utteranceBytes = 0;
    this.ringBuffer.clear();
  }

  _emit(pcm) {
    this.onUtterance(this.channel, Buffer.from(pcm));
  }

  _millisecondsToBytes(durationMs) {
    return Math.floor(this.sampleRate * PCM_BYTES_PER_SAMPLE * durationMs / 1000);
  }
}

module.exports = {
  UtteranceSegmenter,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_PRE_ROLL_MS,
  DEFAULT_MIN_UTTERANCE_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_OVERLAP_MS
};
