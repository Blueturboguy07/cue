// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session)
// or Deepgram Nova streaming. Falls back to batch Whisper/Gemini if streaming unavailable.
//
// This module manages a persistent WebSocket connection for real-time transcription
// with sub-200ms latency, interim results, and automatic reconnection.

const { looksLikeHallucination } = require('./stt');
const { pcmToWav } = require('./wav');
const { resolveGeminiModel } = require('./llm');

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
    this._pendingAudio = [];
    this._sessionReady = false;
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      // GA transcription endpoint: use ?intent=transcription (NOT ?model=)
      // The transcription model goes inside the session config
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      this.ws.on('open', () => {
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

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._sessionReady = false;
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
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
    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._sessionReady = false;
    this._pendingAudio = [];
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
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
    this._keepAliveInterval = null;
    this._committed = ''; // is_final segments not yet closed out by speech_final
  }

  async connect() {
    if (this.ws && this.connected) return;

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

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `Token ${this.apiKey}` }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        // Keep-alive every 3 seconds to prevent timeout
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) { /* ignore */ }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._clearKeepAlive();
        this.onStatusChange('disconnected');
        if (code !== 1000) this._attemptReconnect();
      });

      this.ws.on('error', (err) => {
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
    setTimeout(() => this.connect(), Math.min(delay, 16000));
  }

  disconnect() {
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      // Send CloseStream message for clean shutdown
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* ignore */ }
      this.ws.close(1000);
      this.ws = null;
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

async function transcribeBatchGemini(apiKey, wav, model) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: model || resolveGeminiModel(),
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// ============================================================================
// Unified Streaming STT Factory
// Creates the best available streaming STT based on the user's API keys.
// Priority: Deepgram (lowest latency) > OpenAI Realtime > Batch fallback
// ============================================================================

function createStreamingSTT(settings, channel, callbacks) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const { onTranscript, onInterim, onError, onStatusChange } = callbacks;

  if (selectedProvider === 'local' || selectedProvider === 'gemini') {
    return { type: 'batch', provider: selectedProvider, instance: null };
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

  // Priority 3: Batch fallback (Gemini or Whisper via old system)
  return {
    type: 'batch',
    provider: selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none',
    instance: null
  };
}

module.exports = {
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};
