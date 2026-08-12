// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, CURRENT_GEMINI_DEFAULT } = require('./llm');
const { XAI_STT_URL, resolveGrokApiKey } = require('./grok-cli-auth');

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

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL });
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

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// xAI Speech-to-Text (Grok voice stack) — POST /v1/stt
// Uses the same Grok CLI OAuth / XAI_API_KEY credentials as chat.
// Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
async function transcribeXai(apiKey, wav, keyterms) {
  if (!apiKey) throw new Error('Missing Grok / xAI credentials for speech-to-text.');
  const form = new FormData();
  // Option fields must precede `file` per xAI multipart requirements.
  form.append('language', 'en');
  form.append('format', 'true');
  const terms = Array.isArray(keyterms) ? keyterms : [];
  for (const term of terms.slice(0, 100)) {
    const t = String(term || '').trim().slice(0, 50);
    if (t) form.append('keyterm', t);
  }
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch(XAI_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const err = new Error(detail || `xAI STT HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'grok';
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  return String((data && data.text) || '').trim();
}

function vocabKeyterms(prompt) {
  // buildVocabPrompt returns a comma-separated list — turn a few into keyterms.
  return String(prompt || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function shouldUseGrokStt(settings, selectedProvider) {
  // Explicit Grok STT always tries CLI login / XAI_API_KEY / Settings key.
  if (selectedProvider === 'grok' || selectedProvider === 'xai') return true;
  // Auto only picks Grok voice when chat is also Grok, or an explicit xAI key was saved.
  // That avoids hijacking STT for Custom/OpenAI installs just because `grok login` exists.
  if (selectedProvider === 'auto') {
    const keys = settings.apiKeys || {};
    return settings.provider === 'grok' || !!String(keys.grok || '').trim();
  }
  return false;
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  const grokKey = shouldUseGrokStt(settings, selectedProvider) ? resolveGrokApiKey(keys.grok) : '';
  // Prefer Grok voice STT when selected (or auto + Grok chat).
  if (grokKey && (selectedProvider === 'auto' || selectedProvider === 'grok' || selectedProvider === 'xai')) {
    chain.push({
      p: 'grok',
      fn: (wav) => transcribeXai(resolveGrokApiKey(keys.grok), wav, vocabKeyterms(vocabPrompt))
    });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel, undefined, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(keys.groq, wav, 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }
  // Explicit openai selection still prioritizes openai if both were somehow queued.
  if (selectedProvider === 'openai' && keys.openai && chain.length > 1) {
    const idx = chain.findIndex((c) => c.p === 'openai');
    if (idx > 0) chain.unshift(chain.splice(idx, 1)[0]);
  }

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          const quota = isQuotaError(e);
          const message = formatProviderErrorMessage(e, c.p);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p };
          if (quota) {
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

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt, transcribeXai };
