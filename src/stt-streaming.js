// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session),
// Deepgram Nova streaming, or Gemini's transcribe-live model over the Live API.
// Falls back to batch Whisper/Gemini if streaming unavailable.
//
// This module manages a persistent WebSocket connection for real-time transcription
// with sub-200ms latency, interim results, and automatic reconnection.

const { looksLikeHallucination, transcribeGemini, buildVocabPrompt, publikOwnsAutoAudio } = require('./stt');
const { pcmToWav } = require('./wav');
const { GEMINI_TRANSCRIBE_LIVE_MODEL } = require('./llm');

// ============================================================================
// OpenAI Realtime Transcription Session (WebSocket)
// Uses the dedicated transcription session type for lowest latency streaming STT
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'gpt-realtime-whisper';
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._pendingAudio = [];
    this._sessionReady = false;
    this._closedByUs = false; // disconnect() was called: ignore the socket's dying breaths, never reconnect
  }

  async connect() {
    if (this.ws && this.connected) return;
    this._closedByUs = false;

    try {
      const WebSocket = require('ws');
      // GA transcription endpoint: use ?intent=transcription (NOT ?model=)
      // The transcription model goes inside the session config
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return; // superseded by a later connect()/disconnect()
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');

        // Configure the transcription session (GA format)
        this._sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: this.model,
                  language: 'en'
                }
              }
            }
          }
        });
      });

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      ws.on('close', (code) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this._sessionReady = false;
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting && !this._closedByUs) {
          this._attemptReconnect();
        }
      });

      ws.on('error', (err) => {
        // Closing a socket that is still in the handshake makes `ws` emit
        // "WebSocket was closed before the connection was established" — that
        // is our own disconnect(), not a provider failure.
        if (this.ws !== ws || this._closedByUs) return;
        this.onError({ provider: 'openai-realtime', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'openai-realtime', message: e.message, status: null });
    }
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this._sessionReady = true;
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.onInterim(event.delta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript && event.transcript.trim()) {
          this.onTranscript(event.transcript.trim());
        }
        break;

      case 'input_audio_buffer.speech_started':
        break;

      case 'input_audio_buffer.speech_stopped':
        break;

      case 'input_audio_buffer.committed':
        break;

      case 'error':
        this.onError({
          provider: 'openai-realtime',
          message: event.error?.message || 'Unknown realtime error',
          status: event.error?.code
        });
        break;
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.connected || !this._sessionReady) {
      // Buffer audio until session is ready (max 5 seconds worth)
      this._pendingAudio.push(pcmBuffer);
      if (this._pendingAudio.length > 80) this._pendingAudio.shift();
      return;
    }

    // Resample 16kHz -> 24kHz (linear interpolation) since the API requires 24kHz
    const resampled = this._resample16to24(Buffer.from(pcmBuffer));
    const b64 = resampled.toString('base64');
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: b64
    });
  }

  _resample16to24(pcm16kHz) {
    // Linear interpolation from 16000 Hz to 24000 Hz (ratio 2:3)
    const srcSamples = pcm16kHz.length / 2;
    const dstSamples = Math.floor(srcSamples * 24000 / 16000);
    const out = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcPos = i * 16000 / 24000;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = idx < srcSamples ? pcm16kHz.readInt16LE(idx * 2) : 0;
      const s1 = (idx + 1) < srcSamples ? pcm16kHz.readInt16LE((idx + 1) * 2) : s0;
      const sample = Math.round(s0 + (s1 - s0) * frac);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return out;
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0) {
      const chunk = this._pendingAudio.shift();
      const resampled = this._resample16to24(Buffer.from(chunk));
      const b64 = resampled.toString('base64');
      this._sendEvent({
        type: 'input_audio_buffer.append',
        audio: b64
      });
    }
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
      this.ws.send(JSON.stringify(event));
    }
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'openai-realtime', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this.reconnecting = true;
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.reconnecting = false;
      if (!this._closedByUs) this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.reconnecting = false;
    this._sessionReady = false;
    this._pendingAudio = [];
    if (this.ws) {
      const ws = this.ws;
      this.ws = null; // detach first so the resulting close/error events are ignored
      try { ws.close(1000); } catch (e) { /* ignore */ }
    }
    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova Streaming STT (WebSocket)
// Ultra-low latency, supports interim results, speaker diarization, punctuation
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'nova-3';
    this.ws = null;
    this.connected = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._keepAliveInterval = null;
    this._committed = ''; // is_final segments not yet closed out by speech_final
    this._closedByUs = false; // disconnect() was called: ignore the socket's dying breaths, never reconnect
  }

  async connect() {
    if (this.ws && this.connected) return;
    this._closedByUs = false;

    try {
      const WebSocket = require('ws');
      const params = new URLSearchParams({
        model: this.model,
        language: 'en',
        smart_format: 'true',
        interim_results: 'true',
        utterance_end_ms: '1000',
        vad_events: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        endpointing: '300',
        punctuate: 'true'
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      const ws = new WebSocket(url, {
        headers: { 'Authorization': `Token ${this.apiKey}` }
      });
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return; // superseded by a later connect()/disconnect()
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        // Keep-alive every 3 seconds to prevent timeout
        this._clearKeepAlive();
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) { /* ignore */ }
      });

      ws.on('close', (code) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this._clearKeepAlive();
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this._closedByUs) this._attemptReconnect();
      });

      ws.on('error', (err) => {
        // Closing a socket that is still in the handshake makes `ws` emit
        // "WebSocket was closed before the connection was established" — that
        // is our own disconnect(), not a provider failure.
        if (this.ws !== ws || this._closedByUs) return;
        this.onError({ provider: 'deepgram', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'deepgram', message: e.message, status: null });
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || '').trim();

      // Deepgram splits one spoken sentence into several is_final segments and only sets
      // speech_final on the last one. Accumulate the is_final pieces and emit a single turn
      // at speech_final so a sentence is not fragmented across transcript rows.
      if (msg.speech_final) {
        const full = ((this._committed || '') + ' ' + text).trim();
        this._committed = '';
        if (full && !looksLikeHallucination(full)) this.onTranscript(full);
        this.onInterim('');
        return;
      }
      if (!text) return;
      if (msg.is_final) {
        this._committed = ((this._committed || '') + ' ' + text).trim();
        this.onInterim(this._committed);
      } else {
        this.onInterim(((this._committed || '') + ' ' + text).trim());
      }
    } else if (msg.type === 'UtteranceEnd') {
      // Safety net: if endpointing never produced a speech_final, flush whatever is_final
      // segments we accumulated so the turn is not silently dropped.
      this._flushCommitted();
    } else if (msg.type === 'Error') {
      this.onError({ provider: 'deepgram', message: msg.description || msg.message, status: msg.variant });
    }
  }

  _flushCommitted() {
    const full = (this._committed || '').trim();
    this._committed = '';
    if (full && !looksLikeHallucination(full)) this.onTranscript(full);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  _clearKeepAlive() {
    if (this._keepAliveInterval) { clearInterval(this._keepAliveInterval); this._keepAliveInterval = null; }
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'deepgram', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; if (!this._closedByUs) this.connect(); }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null; // detach first so the resulting close/error events are ignored
      // Send CloseStream message for clean shutdown (only meaningful on an open socket)
      if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* ignore */ } }
      try { ws.close(1000); } catch (e) { /* ignore */ }
    }
    this.connected = false;
  }
}


// ============================================================================
// Gemini Live transcription (gemini-*-transcribe-live over the Live API)
// Sends 16 kHz PCM as-is; the server streams interimInputTranscription (the
// full hypothesis so far, refreshed every ~0.5s) and inputTranscription (final,
// on a pause). Sessions are capped at 10 minutes, so an unexpected close is
// normal — audio is buffered while the socket reconnects.
// ============================================================================

const GEMINI_LIVE_CONNECT_TIMEOUT_MS = 15000;
const GEMINI_LIVE_MAX_PENDING_CHUNKS = 100; // ~10s of 100ms chunks while (re)connecting

class GeminiLiveSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || GEMINI_TRANSCRIBE_LIVE_MODEL;
    this.vocabulary = options.vocabulary || [];
    this.session = null;
    this.connected = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._pendingAudio = [];
    this._lastInterim = '';
    this._closedByUs = false;
    this._connecting = false;
    this._conn = null; // token for the current socket so a stale one can't drive callbacks
    // Injectable for tests; production lazily loads @google/genai.
    this._createClient = options.createClient || ((apiKey) => {
      const { GoogleGenAI } = require('@google/genai');
      return new GoogleGenAI({ apiKey });
    });
  }

  async connect() {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    this._closedByUs = false;
    const conn = { closed: false };
    this._conn = conn;
    try {
      const ai = this._createClient(this.apiKey);
      // The SDK's connect() only resolves after setupComplete and never rejects:
      // a rejected session (bad key, unknown model, quota) arrives as a socket
      // close carrying the reason, so race it against that close and a timeout.
      let rejectClosed = () => {};
      const closedEarly = new Promise((_, reject) => { rejectClosed = reject; });
      const attempt = ai.live.connect({
        model: this.model,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: {
            languageCodes: [], // auto-detect, like the batch Gemini path
            customVocabulary: this.vocabulary.slice(0, 1000)
          }
        },
        callbacks: {
          onmessage: (msg) => { if (this._conn === conn) this._handleMessage(msg); },
          onerror: (err) => {
            if (this._conn !== conn) return;
            this.onError({ provider: 'gemini-live', message: (err && err.message) || 'Gemini Live connection error', status: null });
          },
          onclose: (evt) => {
            if (this._conn !== conn || conn.closed) return;
            conn.closed = true;
            const reason = (evt && evt.reason) || '';
            if (!this.connected) { rejectClosed(new Error(reason || `Gemini Live closed before setup (code ${evt && evt.code})`)); return; }
            this._onClosed(evt);
          }
        }
      });
      let timer = null;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gemini Live connection timed out')), GEMINI_LIVE_CONNECT_TIMEOUT_MS); });
      try {
        this.session = await Promise.race([attempt, closedEarly, timeout]);
      } finally {
        clearTimeout(timer); // don't keep the process alive for a race that already settled
      }
      if (this._conn !== conn) { try { this.session.close(); } catch (e) { /* ignore */ } return; } // disconnect() raced us
      this.connected = true;
      this._reconnectAttempts = 0;
      this.onStatusChange('connected');
      this._flushPendingAudio();
    } catch (e) {
      this.session = null;
      const message = (e && e.message) || String(e);
      // Rejected sessions carry the API error in the close reason ("API key not
      // valid", "... is not found for API version ...", quota text) — surface a
      // status so the shared error mapping in stt.js/llm.js reads it the same.
      const status = /not found|not supported/i.test(message) ? 404 : (/quota|rate limit|resource_exhausted/i.test(message) ? 429 : null);
      this.onError({ provider: 'gemini-live', message, status });
    } finally {
      this._connecting = false;
    }
  }

  _handleMessage(msg) {
    const sc = msg && msg.serverContent;
    if (!sc) return;
    if (sc.interimInputTranscription && typeof sc.interimInputTranscription.text === 'string') {
      this._lastInterim = sc.interimInputTranscription.text;
      this.onInterim(this._lastInterim);
    } else if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
      const text = sc.inputTranscription.text.trim();
      this._lastInterim = '';
      if (text && !looksLikeHallucination(text)) this.onTranscript(text);
      this.onInterim('');
    }
  }

  // Server-initiated close: the 10-minute session cap, or a network blip.
  _onClosed(evt) {
    this.connected = false;
    this.session = null;
    this.onStatusChange('disconnected');
    // Whatever the model had recognised so far is the best transcript of the
    // utterance the close cut off; don't let it vanish.
    this._flushInterimAsFinal();
    if (this._closedByUs) return;
    this._attemptReconnect();
  }

  _flushInterimAsFinal() {
    const text = (this._lastInterim || '').trim();
    this._lastInterim = '';
    if (text && !looksLikeHallucination(text)) this.onTranscript(text);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (!this.connected || !this.session) {
      // Buffer audio until the session is (re)connected so the words spoken
      // across the 10-minute rollover are not lost.
      this._pendingAudio.push(Buffer.from(pcmBuffer));
      if (this._pendingAudio.length > GEMINI_LIVE_MAX_PENDING_CHUNKS) this._pendingAudio.shift();
      return;
    }
    this._send(Buffer.from(pcmBuffer));
  }

  _send(buf) {
    try {
      this.session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (e) {
      this.onError({ provider: 'gemini-live', message: e.message, status: null });
    }
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0 && this.connected) this._send(this._pendingAudio.shift());
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'gemini-live', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; if (!this._closedByUs) this.connect(); }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closedByUs = true;
    this._conn = null; // orphan any in-flight connect so its callbacks are ignored
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._pendingAudio = [];
    this._flushInterimAsFinal();
    if (this.session) {
      try { this.session.sendRealtimeInput({ audioStreamEnd: true }); } catch (e) { /* ignore */ }
      try { this.session.close(); } catch (e) { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Batch STT (enhanced version of the original — used as fallback)
// Supports Whisper and Gemini with better error handling
// ============================================================================

async function transcribeBatchOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    response_format: 'text',
    language: 'en'
  });
  return (typeof res === 'string' ? res : res.text || '').trim();
}

// Shared with the batch path in stt.js so both use the transcribe model.
const transcribeBatchGemini = transcribeGemini;

// ============================================================================
// Unified Streaming STT Factory
// Creates the best available streaming STT based on the user's API keys.
// Priority: Deepgram (lowest latency) > OpenAI Realtime > Batch fallback
// ============================================================================

function createStreamingSTT(settings, channel, callbacks) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const { onTranscript, onInterim, onError, onStatusChange } = callbacks;

  if (selectedProvider === 'local') {
    return { type: 'batch', provider: selectedProvider, instance: null };
  }
  // publik as the provider with Auto audio: the batch path transcribes
  // through publik API; an own streaming key is used only when picked on
  // the Audio tab (src/stt.js publikOwnsAutoAudio).
  if (publikOwnsAutoAudio(settings)) {
    return { type: 'batch', provider: 'publik', instance: null };
  }

  // Priority 1: Deepgram (purpose-built for streaming STT, lowest latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'deepgram') && keys.deepgram) {
    const stt = new DeepgramStreamingSTT(keys.deepgram, {
      model: 'nova-3',
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'deepgram', instance: stt };
  }

  // Priority 2: OpenAI Realtime API (excellent quality, slightly higher latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const stt = new OpenAIRealtimeSTT(keys.openai, {
      model: 'gpt-realtime-whisper', // only this model gives true streaming deltas
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'openai-realtime', instance: stt };
  }

  // Priority 3: Gemini transcribe-live (word-by-word interims; one long-lived
  // session per channel, so it sidesteps the per-request quota that bites the
  // batch Gemini path). Opt-in only: its interim hypotheses get rewritten as
  // it goes, which reads as glitchy next to Deepgram, so 'auto' with a
  // Gemini-only key stays on batch. A failure here falls back to batch Gemini
  // in main.js.
  if (selectedProvider === 'gemini' && keys.gemini) {
    const stt = new GeminiLiveSTT(keys.gemini, {
      vocabulary: buildVocabPrompt(settings).split(',').map((t) => t.trim()).filter(Boolean),
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'gemini-live', instance: stt };
  }

  // Priority 4: Batch fallback (Gemini or Whisper via old system). Custom has
  // no streaming protocol of its own (an arbitrary OpenAI-compatible endpoint
  // isn't assumed to speak Realtime), so an explicit 'custom' choice lands
  // here too and is served by createSTT()'s batch chain — same as local/gemini.
  return {
    type: 'batch',
    provider: selectedProvider === 'custom' ? 'custom' : (selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none'),
    instance: null
  };
}

module.exports = {
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  GeminiLiveSTT,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};
