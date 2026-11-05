// main.js transcription flow in a vm: flushChannel, the retry, the stop flush
// and a new session, with a fake whisper and a fake clock. (Not a test file:
// the test glob is test/*.test.js.)
//
// plan: one entry per whisper request, in order: null or { text } = text back,
// { status, retryAfterMs } = that error, { hold: true, ...} = the request
// stays in flight until release(n) is called (then answers as planned).
// Each createSTT() is a new transcriber with its own 30 s local back-off
// after a 429, as in src/stt.js: a reused transcriber answers "waiting 30s
// before retrying" without a request.
const vm = require('vm');
const { readSource, fnFrom } = require('./source-text');
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');
const S = require('./stt-synth');

// Let the fake requests (resolved promises) and their awaits run out.
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

// By name, so the same tests also run on an older main.js (one without
// startSttSession) to show what they catch there.
const NAMES = ['flushChannel', 'isPassingSttError', 'sttRetryDelayMs', 'lostAudioMessage', 'reportLostAudio',
  'transcribePiece', 'startSttSession', 'takeHeldAudio', 'sendHeldAudio'];
function fnByName(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(.*$`, 'm').exec(src);
  return m ? fnFrom(src, m[0]) : '';
}

function mainHarness({ plan = [], batcherOpts = {} } = {}) {
  const src = readSource('main.js');
  const code = NAMES.map((name) => fnByName(src, name)).join('\n');
  // Top-level values of main.js the functions use (when this main.js has them).
  const consts = ['NEW_SESSION_FIRST'].map((name) => (new RegExp(`^const ${name} = .*;$`, 'm').exec(src) || [''])[0]).join('\n');
  let t = 1e6;
  const requests = []; const notices = []; const turns = []; const reported = []; const waits = []; const events = [];
  const held = new Map();
  let sttMade = 0;
  function makeStt() {
    sttMade++;
    let disabledUntil = 0;
    return {
      available: true, providers: ['publik'],
      transcribe: (pcm, opts = {}) => {
        if (disabledUntil && t < disabledUntil) return Promise.resolve({ text: '', error: { provider: 'publik', message: 'Temporary publik quota or rate-limit; waiting 30s before retrying.' } });
        const n = requests.length + 1;
        const step = plan[n - 1] || null;
        requests.push({ n, pcm, context: opts.context, at: t });
        events.push(`request ${n}`);
        const answer = () => {
          if (step && step.status) {
            if (step.status === 429) disabledUntil = t + 30000;
            return { text: '', error: { provider: 'publik', status: step.status, message: step.message || `publik answered ${step.status}`, ...(step.retryAfterMs ? { retryAfterMs: step.retryAfterMs } : {}) } };
          }
          return { text: (step && step.text) || `text ${n}`, provider: 'publik' };
        };
        if (step && step.hold) return new Promise((resolve) => held.set(n, () => resolve(answer())));
        return Promise.resolve(answer());
      }
    };
  }
  const ctx = vm.createContext({
    state: { capturing: true, transcribing: { you: false, them: false } },
    buffers: { you: [], them: [] },
    publikSttBatchers: { you: new UtteranceBatcher({ now: () => t, ...batcherOpts }), them: new UtteranceBatcher({ now: () => t, ...batcherOpts }) },
    sttInFlight: { you: Promise.resolve(null), them: Promise.resolve(null) },
    sttSession: 1, stopFlush: null, STOP_FLUSH_MS: 40000, lastSttText: { you: '', them: '' }, sttSessionShown: false,
    publikSttNoticeAt: 0,
    store: { getSettings: () => ({}) }, createSTT: makeStt, publik: { PUBLIK_PROVIDER: 'publik' },
    MIN_BYTES: 3840, RMS_GATE: 180, rms16: S.rms, DEFAULT_MIN_GAP_MS: 2500, sttDisabled: false,
    send: (ch, p) => { if (ch === 'status') { notices.push(p.message); events.push(`status: ${p.message}`); } },
    pushTranscript: (turn) => { turns.push(turn); events.push(`turn: ${turn.text}`); },
    recordEvent: () => {}, noTranscriptionMessage: () => 'off',
    handleSttError: (err) => { reported.push(err); events.push(`reported ${err.status}`); },
    console, Date: { now: () => t }, Buffer, Promise,
    // A wait moves the fake clock on at once.
    setTimeout: (fn, ms) => { waits.push(ms); t += ms || 0; fn(); return 0; }
  });
  vm.runInContext(consts + '\n' + code + "\nthis.api = { flushChannel, takeHeldAudio, sendHeldAudio, startSttSession: typeof startSttSession === 'function' ? startSttSession : null };", ctx);
  const win = 0.9 * BYTES_PER_SECOND;
  return {
    api: ctx.api, ctx, requests, turns, reported, notices, waits, events,
    sttMade: () => sttMade,
    tick: (ms) => { t += ms; },
    now: () => t,
    release: async (n) => { const r = held.get(n); if (!r) throw new Error(`request ${n} is not in flight`); held.delete(n); r(); await settle(); },
    // Feed audio to a channel ("them" unless named) in 900 ms windows, one
    // flushChannel each, as the 900 ms timer does: not awaited, so a held
    // request stays in flight while the next windows arrive (they wait in
    // the buffer).
    async feed(audio, { thenTicks = 0, channel = 'them' } = {}) {
      for (let off = 0; off < audio.length; off += win) { ctx.buffers[channel].push(audio.subarray(off, off + win)); t += 900; ctx.api.flushChannel(channel); await settle(); }
      for (let i = 0; i < thenTicks; i++) { t += 900; ctx.api.flushChannel(channel); await settle(); }
    },
    // The stop path of setCapturing, in its order.
    stop() {
      ctx.state.capturing = false;
      const lastWords = ctx.api.sendHeldAudio(ctx.api.takeHeldAudio()).catch(() => {});
      ctx.buffers.you = []; ctx.buffers.them = [];
      ctx.publikSttBatchers.you.reset(); ctx.publikSttBatchers.them.reset();
      return lastWords.then(() => events.push('notes'));
    },
    start() { if (ctx.api.startSttSession) ctx.api.startSttSession(); ctx.state.capturing = true; }
  };
}

module.exports = { mainHarness };
