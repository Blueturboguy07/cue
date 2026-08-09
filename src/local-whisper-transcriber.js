const { UtteranceSegmenter } = require('./utterance-segmenter');
const { WhisperServerSession } = require('./whisper-server-session');

const CHANNELS = Object.freeze(['you', 'them']);
const DEFAULT_DRAIN_TIMEOUT_MS = 15000;

class LocalWhisperTranscriber {
  /** Coordinate two audio channels through one sequential, persistent model session. */
  constructor({
    sessionOptions,
    sessionFactory = (options) => new WhisperServerSession(options),
    segmenterFactory = (options) => new UtteranceSegmenter(options),
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    onTranscript = () => {},
    onSpeechState = () => {},
    onStatus = () => {},
    onError = () => {}
  }) {
    this.session = sessionFactory({ ...sessionOptions, onState: onStatus });
    this.segmenterFactory = segmenterFactory;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onTranscript = onTranscript;
    this.onSpeechState = onSpeechState;
    this.onStatus = onStatus;
    this.onError = onError;
    this.segmenters = new Map();
    this.queueTail = Promise.resolve();
    this.pendingJobs = 0;
    this.acceptingAudio = false;
    this.discardPendingJobs = false;
  }

  async start() {
    this.discardPendingJobs = false;
    await this.session.start();
    for (const channel of CHANNELS) {
      const isRemoteAudio = channel === 'them';
      this.segmenters.set(channel, this.segmenterFactory({
        channel,
        vadOptions: {
          onsetThreshold: isRemoteAudio ? 200 : 220,
          offsetThreshold: isRemoteAudio ? 120 : 130,
          silenceFrames: isRemoteAudio ? 20 : 18
        },
        onSpeechState: (speechChannel, speaking, durationMs) => {
          this.onSpeechState(speechChannel, speaking, durationMs);
        },
        onUtterance: (utteranceChannel, pcm) => this._enqueue(utteranceChannel, pcm)
      }));
    }
    this.acceptingAudio = true;
  }

  push(channel, pcm) {
    if (!this.acceptingAudio) return;
    const segmenter = this.segmenters.get(channel);
    if (!segmenter) throw new Error(`Unknown local Whisper channel: ${channel}`);
    segmenter.push(pcm);
  }

  async stop() {
    this.acceptingAudio = false;
    for (const segmenter of this.segmenters.values()) segmenter.stop();

    const drained = await this._drainQueue();
    if (!drained) {
      this.discardPendingJobs = true;
      this.session.abortInferences();
    }
    await this.session.stop({ force: !drained });
    this.segmenters.clear();
    this.onStatus({ status: 'off', message: 'Local Whisper stopped.' });
  }

  forceStop() {
    this.acceptingAudio = false;
    this.discardPendingJobs = true;
    this.session.abortInferences();
    return this.session.stop({ force: true });
  }

  _enqueue(channel, pcm) {
    this.pendingJobs += 1;
    this.onStatus({ status: 'transcribing', channel, pending: this.pendingJobs });

    const job = this.queueTail.then(async () => {
      if (this.discardPendingJobs) return;
      const text = await this.session.transcribe(pcm);
      if (text) this.onTranscript(channel, text);
    });

    this.queueTail = job
      .catch((error) => {
        if (!this.discardPendingJobs) this.onError(error);
      })
      .finally(() => {
        this.pendingJobs -= 1;
        if (this.acceptingAudio && this.pendingJobs === 0) {
          this.onStatus({ status: 'ready', message: 'Local Whisper is ready.' });
        }
      });
    return job;
  }

  async _drainQueue() {
    let timeout = null;
    try {
      return await Promise.race([
        this.queueTail.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), this.drainTimeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

module.exports = { LocalWhisperTranscriber, CHANNELS, DEFAULT_DRAIN_TIMEOUT_MS };
