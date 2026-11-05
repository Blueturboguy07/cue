// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, isRateLimitError, isNotFoundError, resolveGeminiModel, CURRENT_GEMINI_DEFAULT, GEMINI_TRANSCRIBE_MODEL } = require('./llm');
const { PUBLIK_PROVIDER, DEFAULT_BASE_URL: PUBLIK_DEFAULT_BASE_URL } = require('./publik');

const BASE_VOCAB = 'CI/CD, Docker, Kubernetes, Terraform, Jenkins, AWS, Azure, GCP, ' +
  'CodeCommit, CodePipeline, CodeBuild, CodeDeploy, DevOps, SRE, microservices, deployment, ' +
  'pipeline, container, orchestration, Ansible, Prometheus, Grafana, Helm, EKS, ECS, Lambda, ' +
  'S3, EC2, IAM, GitHub Actions, GitLab, Kafka, PostgreSQL, Redis, MongoDB, REST API, gRPC';

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

function buildVocabPrompt(settings) {
  const s = settings || {};
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  let prompt = BASE_VOCAB + (proper.length ? ', ' + proper.slice(0, 60).join(', ') : '');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt, clientOptions = {}) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL, ...clientOptions });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    language: 'en',
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

// gemini-*-transcribe models answer with { audioTranscription: { text } } parts,
// which the SDK's res.text getter ignores (it only concatenates `text` parts),
// so read both shapes off the raw candidate. Silence comes back as no parts.
function extractGeminiTranscript(res) {
  const parts = (res && res.candidates && res.candidates[0] && res.candidates[0].content &&
    res.candidates[0].content.parts) || [];
  let out = '';
  for (const part of parts) {
    if (!part || part.thought) continue;
    if (part.audioTranscription && typeof part.audioTranscription.text === 'string') out += part.audioTranscription.text;
    else if (typeof part.text === 'string') out += part.text;
  }
  return out.trim();
}

// gemini-3.5-transcribe is capped at 10 requests/min per model on free-tier
// keys, and flushChannel in main.js sends a clip every ~900ms per channel
// while someone is talking — so a 429 from it is routine, not a dead key.
// Park the model for a minute and use the chat model (far higher per-minute
// quota) for the same clip, instead of letting the error reach main.js's
// handleSttError, which switches transcription off for the whole session.
const TRANSCRIBE_MODEL_COOLDOWN_MS = 60000;
let transcribeModelDownUntil = 0;

// Split from transcribeGemini so tests can pass a fake client.
async function transcribeGeminiWith(ai, wav, now = Date.now()) {
  const audio = { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } };
  if (now >= transcribeModelDownUntil) {
    try {
      // The dedicated transcription model needs no instruction prompt.
      const res = await ai.models.generateContent({
        model: GEMINI_TRANSCRIBE_MODEL,
        contents: [{ role: 'user', parts: [audio] }]
      });
      return extractGeminiTranscript(res);
    } catch (e) {
      // Same key, same provider — only the model id changes, so a retired or
      // rate-limited transcribe model degrades to the chat model rather than
      // to a 404/429 loop. Anything else (bad key, network) still propagates.
      if (!isNotFoundError(e) && !isQuotaError(e)) throw e;
      transcribeModelDownUntil = now + TRANSCRIBE_MODEL_COOLDOWN_MS;
    }
  }
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      audio
    ] }]
  });
  return extractGeminiTranscript(res);
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  return transcribeGeminiWith(new GoogleGenAI({ apiKey }), wav);
}

// whisper-1 answers in verbose_json with the clip's real duration, so the
// gateway meters the exact length. (A gpt-*-transcribe model reports usage
// by tokens; without a duration the gateway falls back to a size estimate
// that is about ten times a 16 kHz WAV clip.)
const PUBLIK_STT_MODEL = 'whisper-1';
// publik transcription requests: an answer within 30 s (a 14 s piece takes
// about 3 s; the SDK default is 10 minutes, and a hung request blocks the
// channel), and no SDK retries: main.js tries a failed piece once more
// itself, after a pause that keeps the channel's 2.5 s spacing and the key's
// 60 requests a minute.
const PUBLIK_STT_CLIENT = { timeout: 30000, maxRetries: 0 };

// Retry-After (seconds) or retry-after-ms of a failed request, in ms; 0 if none.
function retryAfterHeaderMs(e) {
  const h = e && e.headers;
  if (!h) return 0;
  const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k]);
  const ms = Number(get('retry-after-ms'));
  if (ms > 0) return Math.round(ms);
  const s = Number(get('retry-after'));
  return s > 0 ? Math.round(s * 1000) : 0;
}

// A piece that starts at a cut (the talk before it goes on): its prompt is
// only the end of the text before it, as what was said just before, with
// the vocabulary left out, and a final "." made a ",". With no context,
// whisper guessed the first words of the piece ("My lead" -> "MyLED",
// verify of eee01af). Measured on the verifier's `long` speech (whisper-1,
// the same audio pieces, 2026-11-05):
//   - "Who reviewed the fix? My lead reviewed it": vocabulary only "MyLED"
//     2/2; vocabulary + context "Myled" 5/5 (context before or after the
//     list); no prompt "Myled"; context only "My lead" 3/3.
//   - "what interested you about this role,": context ending "team." gave
//     "What interest did you about this role?" 4/4 (a new question); ending
//     "team," gave "what interested you" 2/2; with no final mark, wrong.
// whisper ends every piece as a sentence, so a "." before a cut is most often
// a comma; "?" and "!" are kept. Short (at most CONTEXT_CHARS, whole words),
// so the prompt stays small, and it is never the vocabulary list that read
// back as "CodePipeline" over silence.
const CONTEXT_CHARS = 160;

function contextTail(context) {
  const text = String(context || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= CONTEXT_CHARS) return text;
  const cut = text.slice(-CONTEXT_CHARS);
  const space = cut.indexOf(' ');
  return space < 0 ? cut : cut.slice(space + 1);
}

function promptWithContext(vocabPrompt, context) {
  const tail = contextTail(context);
  if (!tail) return vocabPrompt;
  if (/[?!]["')\]]*$/.test(tail)) return tail;
  return tail.replace(/[\s.,;:\u2026]+$/, '') + ',';
}

// whisper sometimes repeats the end of its prompt before the new words; drop
// such a repeat (3 or more words that end the context) from the start. A
// text that is only such a repeat is the prompt read back (over silence or
// noise), not speech: it becomes no text.
function stripContextEcho(text, context) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const ctx = contextTail(context).split(/\s+/).filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  for (let n = Math.min(ctx.length, words.length); n >= 3; n--) {
    let same = true;
    for (let i = 0; i < n && same; i++) same = norm(words[i]) === norm(ctx[ctx.length - n + i]) && norm(words[i]) !== '';
    if (same) return words.slice(n).join(' ');
  }
  return String(text || '').trim();
}

// The text of a piece that starts at a cut is its own turn: when the text
// before it ended a sentence, it starts with a capital ("describe a
// situation" after "...about deadlines." and a "," prompt).
function continuedText(text, context) {
  if (!text || !/[.?!]["')\]]*$/.test(String(context || '').trim())) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** { apiKey, baseURL, model } when publik can transcribe for this person, else null. */
function publikTranscription(settings) {
  const s = settings || {};
  const keys = s.apiKeys || {};
  const p = s.publik || {};
  if (s.provider !== PUBLIK_PROVIDER || !keys.publik || p.revoked) return null;
  const base = String(p.baseUrl || PUBLIK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { apiKey: keys.publik, baseURL: base, model: PUBLIK_STT_MODEL };
}

// With publik as the provider, "Auto" transcription means publik API. An own
// audio key (OpenAI, Groq, Gemini, Deepgram) is used only when the person
// picked that provider on the Audio tab. Before 0.2.9 Auto tried an old own
// OpenAI key first: a 0.2.4 user who switched to publik saw "Incorrect API
// key" and got a split transcript (smoke test 2026-11-02, v0.2.8).
function publikOwnsAutoAudio(settings) {
  const s = settings || {};
  return s.provider === PUBLIK_PROVIDER && (s.sttProvider || 'auto') === 'auto';
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  // 'auto' for the own-key providers below; off while publik owns Auto.
  const ownAuto = selectedProvider === 'auto' && !publikOwnsAutoAudio(settings);
  // Each entry carries the model id it actually sends, so a failure can name
  // that id back to the user instead of a hardcoded one they never picked.
  if ((ownAuto || selectedProvider === 'openai') && keys.openai) {
    const model = settings.sttModel || 'whisper-1';
    chain.push({ p: 'openai', m: model, fn: (wav) => transcribeOpenAI(keys.openai, wav, model, undefined, vocabPrompt) });
  }
  if ((ownAuto || selectedProvider === 'groq') && keys.groq) {
    const model = 'whisper-large-v3-turbo';
    chain.push({ p: 'groq', m: model, fn: (wav) => transcribeOpenAI(keys.groq, wav, model, 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((ownAuto || selectedProvider === 'gemini') && keys.gemini) {
    // transcribeGemini always tries the dedicated GEMINI_TRANSCRIBE_MODEL first
    // (falling back to CURRENT_GEMINI_DEFAULT only on a 404/429 cooldown); `m`
    // here is just what error messages/`stt.models` report, resolved the same
    // way the chat path picks a model.
    const model = resolveGeminiModel(settings);
    chain.push({ p: 'gemini', m: model, fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }
  // Custom (OpenAI-compatible) endpoint: same shape as the Groq branch above,
  // just pointed at the user's own Base URL. Deliberately NOT part of 'auto' —
  // unlike a named provider, an arbitrary custom endpoint isn't known to speak
  // the audio-transcription API at all, so this only fires on an explicit
  // choice, and only once both the URL and the key it needs are actually set.
  if (selectedProvider === 'custom' && keys.custom && settings.baseUrl) {
    chain.push({ p: 'custom', fn: (wav) => transcribeOpenAI(keys.custom, wav, settings.sttModel, settings.baseUrl, vocabPrompt) });
  }
  if (keys.openai && chain.length > 1) chain.unshift(chain.splice(chain.findIndex((c) => c.p === 'openai'), 1)[0]);
  // publik API: the transcription path for a person who runs cue on publik
  // (smoke test 2026-11-02: such a Mac user got "No transcription key set"
  // and no transcript). In 'auto' it is the only entry (publikOwnsAutoAudio);
  // only while publik is the selected provider and its key is live, so a
  // person who moved to another provider is never charged on publik for audio.
  const publikStt = publikTranscription(settings);
  if (selectedProvider === 'auto' && publikStt) {
    chain.push({ p: 'publik', m: publikStt.model, fn: async (wav, opts) => {
      const context = opts && opts.context;
      const text = await transcribeOpenAI(publikStt.apiKey, wav, publikStt.model, publikStt.baseURL, promptWithContext(vocabPrompt, context), PUBLIK_STT_CLIENT);
      return context ? continuedText(stripContextEcho(text, context), context) : text;
    } });
  }

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    models: chain.map((c) => c.m),
    // opts.context: the text just before this piece when it starts at a cut
    // (publik only; see promptWithContext).
    async transcribe(pcm, opts = {}) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav, opts);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          // Both exhaustion and a plain rate limit mean "stop hammering this
          // provider" — the 30s cooldown below covers both (it always did, via
          // the old status===429 catch-all inside isQuotaError; now that a
          // rate limit is classified separately, it has to be named here too).
          const backOff = isQuotaError(e) || isRateLimitError(e);
          // publik failures come back as an Error with one action (Reconnect,
          // or a publikhq.com link); every other provider as a string.
          const formatted = formatProviderErrorMessage(e, c.p, c.m);
          const message = formatted instanceof Error ? formatted.message : formatted;
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p, model: c.m };
          const retryAfterMs = retryAfterHeaderMs(e);
          if (retryAfterMs) lastErr.retryAfterMs = retryAfterMs;
          if (formatted instanceof Error && formatted.action) lastErr.action = formatted.action;
          if (backOff) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            break;
          }
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, publikTranscription, publikOwnsAutoAudio, PUBLIK_STT_MODEL, PUBLIK_STT_CLIENT, retryAfterHeaderMs, promptWithContext, stripContextEcho, continuedText, CONTEXT_CHARS, looksLikeHallucination, buildVocabPrompt, transcribeGemini, transcribeGeminiWith, extractGeminiTranscript };
