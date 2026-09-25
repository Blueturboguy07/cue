const assert = require('node:assert/strict');
const test = require('node:test');
const { GeminiLiveSTT, createStreamingSTT } = require('../src/stt-streaming');
const { GEMINI_TRANSCRIBE_LIVE_MODEL } = require('../src/llm');

// node:test's mock timers took an array before Node 20.4 and take { apis } after it.
// CI still runs Node 18, so accept both forms.
function enableMockTimeout(t) {
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  } catch (err) {
    if (err.code !== 'ERR_INVALID_ARG_TYPE') throw err;
    t.mock.timers.enable(['setTimeout']);
  }
}

// Fake @google/genai live client. `script` decides what a connect attempt does:
//   'ok'            -> resolves a session (after callbacks.onopen semantics)
//   'closed:<why>'  -> never resolves; fires onclose with that reason (how the SDK reports rejection)
//   'hang'          -> never resolves, never closes
function fakeGenAI(script = 'ok') {
  const state = { connects: [], sessions: [] };
  state.client = {
    live: {
      connect(params) {
        state.connects.push(params);
        const cb = params.callbacks;
        if (script.startsWith('closed:')) {
          setImmediate(() => cb.onclose({ code: 1007, reason: script.slice(7) }));
          return new Promise(() => {});
        }
        if (script === 'hang') return new Promise(() => {});
        const session = {
          sent: [],
          closed: false,
          sendRealtimeInput(input) { if (this.closed) throw new Error('closed'); this.sent.push(input); },
          close() { this.closed = true; },
          // test hooks
          emit: (msg) => cb.onmessage(msg),
          serverClose: (evt) => cb.onclose(evt || { code: 1011, reason: 'session expired' })
        };
        state.sessions.push(session);
        return Promise.resolve(session);
      }
    }
  };
  return state;
}

function make(script, opts = {}) {
  const genai = fakeGenAI(script);
  const events = { transcripts: [], interims: [], errors: [], statuses: [] };
  const stt = new GeminiLiveSTT('key', {
    createClient: () => genai.client,
    vocabulary: ['Kubernetes'],
    onTranscript: (t) => events.transcripts.push(t),
    onInterim: (t) => events.interims.push(t),
    onError: (e) => events.errors.push(e),
    onStatusChange: (s) => events.statuses.push(s),
    ...opts
  });
  return { stt, genai, events };
}

const audio = (n) => Buffer.alloc(n, 1);

test('connects with the transcribe-live model, TEXT modality, and the vocabulary', async () => {
  const { stt, genai, events } = make('ok');
  await stt.connect();
  const params = genai.connects[0];
  assert.equal(params.model, GEMINI_TRANSCRIBE_LIVE_MODEL);
  assert.deepEqual(params.config.responseModalities, ['TEXT']);
  assert.deepEqual(params.config.inputAudioTranscription.customVocabulary, ['Kubernetes']);
  assert.deepEqual(events.statuses, ['connected']);
  assert.equal(stt.connected, true);
});

test('audio sent before the session is up is buffered and flushed once connected, as 16 kHz PCM', async () => {
  const { stt, genai } = make('ok');
  stt.sendAudio(audio(3200));
  stt.sendAudio(audio(3200));
  assert.equal(genai.sessions.length, 0);
  await stt.connect();
  const session = genai.sessions[0];
  assert.equal(session.sent.length, 2);
  assert.equal(session.sent[0].audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(session.sent[0].audio.data, 'base64').length, 3200);
  stt.sendAudio(audio(1600));
  assert.equal(session.sent.length, 3);
});

test('interim messages stream the running hypothesis; a final emits one transcript and clears the interim', async () => {
  const { stt, genai, events } = make('ok');
  await stt.connect();
  const s = genai.sessions[0];
  s.emit({ serverContent: { interimInputTranscription: { text: 'We' } } });
  s.emit({ serverContent: { interimInputTranscription: { text: 'We deployed' } } });
  s.emit({ serverContent: { inputTranscription: { text: 'We deployed the cluster.' } } });
  s.emit({ serverContent: { generationComplete: true } });
  assert.deepEqual(events.interims, ['We', 'We deployed', '']);
  assert.deepEqual(events.transcripts, ['We deployed the cluster.']);
});

test('a final that is only a known Whisper-style artifact is dropped', async () => {
  const { stt, genai, events } = make('ok');
  await stt.connect();
  genai.sessions[0].emit({ serverContent: { inputTranscription: { text: 'Thank you.' } } });
  assert.deepEqual(events.transcripts, []);
});

test('a rejected session (reported by the SDK as a close, not a rejection) surfaces as an error instead of hanging', async () => {
  const { stt, events } = make('closed:API key not valid. Please pass a valid API key.');
  await stt.connect();
  assert.equal(stt.connected, false);
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].provider, 'gemini-live');
  assert.match(events.errors[0].message, /API key not valid/);
  assert.equal(events.errors[0].status, null);
});

test('an unknown-model close is mapped to a 404 so the shared error wording applies', async () => {
  const { stt, events } = make('closed:models/gemini-x is not found for API version v1beta, or is not supported for bidiGenerateContent.');
  await stt.connect();
  assert.equal(events.errors[0].status, 404);
});

test('a server-initiated close keeps the cut-off hypothesis, reports disconnected, and reconnects with audio buffered meanwhile', async (t) => {
  enableMockTimeout(t);
  const { stt, genai, events } = make('ok');
  await stt.connect();
  const first = genai.sessions[0];
  first.emit({ serverContent: { interimInputTranscription: { text: 'finished in about four' } } });
  first.serverClose({ code: 1011, reason: 'session expired' });
  assert.deepEqual(events.transcripts, ['finished in about four']);
  assert.equal(events.statuses.at(-1), 'disconnected');
  assert.equal(stt.connected, false);

  stt.sendAudio(audio(3200)); // spoken during the rollover
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(genai.sessions.length, 2, 'should have opened a replacement session');
  assert.equal(stt.connected, true);
  assert.equal(genai.sessions[1].sent.length, 1, 'rollover audio reaches the new session');
  assert.deepEqual(events.errors, []);
});

test('disconnect() ends the stream cleanly and does not reconnect', async (t) => {
  enableMockTimeout(t);
  const { stt, genai, events } = make('ok');
  await stt.connect();
  const s = genai.sessions[0];
  s.emit({ serverContent: { interimInputTranscription: { text: 'last words' } } });
  stt.disconnect();
  assert.deepEqual(events.transcripts, ['last words']);
  assert.ok(s.sent.some((m) => m.audioStreamEnd === true));
  assert.equal(s.closed, true);
  s.serverClose({ code: 1000, reason: '' }); // the close we asked for
  t.mock.timers.tick(20000);
  assert.equal(genai.sessions.length, 1, 'must not reconnect after an explicit disconnect');
});

test('a connect that never completes times out with an error rather than wedging the channel', async (t) => {
  enableMockTimeout(t);
  const { stt, events } = make('hang');
  const p = stt.connect();
  t.mock.timers.tick(15000);
  await p;
  assert.match(events.errors[0].message, /timed out/);
});

test('createStreamingSTT uses Gemini Live only when Gemini is chosen explicitly', () => {
  const cb = { onTranscript() {}, onInterim() {}, onError() {}, onStatusChange() {} };
  const explicit = createStreamingSTT({ sttProvider: 'gemini', apiKeys: { gemini: 'g', deepgram: 'd' } }, 'you', cb);
  assert.equal(explicit.type, 'streaming');
  assert.equal(explicit.provider, 'gemini-live');
  assert.ok(explicit.instance instanceof GeminiLiveSTT);

  // 'auto' with a Gemini-only key stays on the steadier batch path.
  assert.deepEqual(createStreamingSTT({ sttProvider: 'auto', apiKeys: { gemini: 'g' } }, 'you', cb),
    { type: 'batch', provider: 'gemini', instance: null });

  const deepgramFirst = createStreamingSTT({ sttProvider: 'auto', apiKeys: { gemini: 'g', deepgram: 'd' } }, 'you', cb);
  assert.equal(deepgramFirst.provider, 'deepgram');

  assert.deepEqual(createStreamingSTT({ sttProvider: 'auto', apiKeys: {} }, 'you', cb),
    { type: 'batch', provider: 'none', instance: null });
});
