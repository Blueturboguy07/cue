// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken, signal }) -> Promise<fullText>

const { createCompatibleClientOptions } = require('./openai-compatible');
const publik = require('./publik');
const { abortable } = require('./abort');

const CUSTOM_PROVIDER = 'custom';
const PUBLIK_PROVIDER = publik.PUBLIK_PROVIDER;
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-3.8-flash is the current
// Flash release (Aug 2026), so it is the single default used everywhere in
// this file and for Gemini transcription in stt.js / stt-streaming.js.
const CURRENT_GEMINI_DEFAULT = 'gemini-3.8-flash';
// Purpose-built speech-to-text model: no thinking tokens, returns nothing on
// silence, and answers with an `audioTranscription` part instead of `text`
// (see extractGeminiTranscript in stt.js). Falls back to
// CURRENT_GEMINI_DEFAULT if Google ever retires it.
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Streaming counterpart over the Live API (bidiGenerateContent): word-by-word
// interim hypotheses plus a final on each pause. Used by GeminiLiveSTT in
// stt-streaming.js; the batch model above is the fallback when it fails.
const GEMINI_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
// claude-3-5-haiku-latest / claude-3-5-sonnet-latest were retired by Anthropic
// (confirmed absent from GET https://api.anthropic.com/v1/models as of Sep 19
// 2026 — every claude-2.x and claude-3.x id 404s with not_found_error).
// claude-haiku-4-5-20251001 / claude-sonnet-4-5-20250929 are current and were
// live-verified with a real request before shipping this default.
const CURRENT_ANTHROPIC_DEFAULT_FAST = 'claude-haiku-4-5-20251001';
const CURRENT_ANTHROPIC_DEFAULT_SMART = 'claude-sonnet-4-5-20250929';
const DEFAULT_MODELS = {
  cerebras: 'qwen-3.8-27b',
  openai: 'gpt-4o-mini',
  anthropic: CURRENT_ANTHROPIC_DEFAULT_FAST,
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  // deepseek-chat/deepseek-reasoner were retired 2026-07-24 and now 404; the
  // replacement aliases are deepseek-flash (non-thinking) and deepseek-v4-pro
  // (thinking), so those are the defaults used everywhere in this file.
  deepseek: 'deepseek-flash',
  azure: 'gpt-4o-mini',
  publik: publik.DEFAULT_MODELS.fast
};
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

// Gemini model ids that Google has since deprecated/retired (the 2.5 family
// went "no longer available to new users" in Sep 2026). A settings file saved
// before this fix can still have one of these persisted on disk, so
// resolveGeminiModel migrates them at read time rather than only fixing the
// default — otherwise an existing user would keep re-hitting the same 404
// forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0|2\.5)(?:-|$)/i;

// Single place that answers "which Gemini model should this request use?".
// Both the chat path (createLLM) and the transcription paths (src/stt.js,
// src/stt-streaming.js) go through here. STT used to skip this and hardcode
// the default instead, so a user who picked a working model in Settings still
// got 404s from a model they had never selected — the app reported a failure
// against a model id that appeared nowhere in their config.
function resolveGeminiModel(settings) {
  const s = settings || {};
  const tier = s.smart ? 'smart' : 'fast';
  const configured = ((s.models || {}).gemini || {})[tier];
  if (!configured || DEAD_GEMINI_MODEL_RE.test(configured)) return CURRENT_GEMINI_DEFAULT;
  return configured;
}

// Same self-heal, for Anthropic: matches every retired claude-2.x/claude-3.x
// id (including the "-latest" aliases), so a settings file saved back when
// claude-3-5-haiku-latest/claude-3-5-sonnet-latest were the shipped defaults
// (store.js's DEFAULTS.models.anthropic, before this fix) gets migrated to a
// live model on next read instead of permanently re-hitting the same 404.
const DEAD_ANTHROPIC_MODEL_RE = /^claude-(2(?:\.\d+)?(?:-|$)|3-)/i;

// Same story for DeepSeek's retired chat/reasoner aliases — map each to its
// closest current replacement rather than collapsing both to one default.
const DEAD_DEEPSEEK_MODEL_RE = /^deepseek-(chat|reasoner)$/i;
const CURRENT_DEEPSEEK_FAST_DEFAULT = 'deepseek-flash';
const CURRENT_DEEPSEEK_SMART_DEFAULT = 'deepseek-v4-pro';

const PROVIDER_LABELS = { azure: 'Azure AI Foundry', cerebras: 'Cerebras', openai: 'OpenAI', minimax: 'MiniMax', publik: publik.PROVIDER_LABEL, deepseek: 'DeepSeek' };

// DeepSeek is OpenAI-compatible and reuses the OpenAI screenshot/streaming path via baseURL.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// A 429 on its own says only "slow down" — it never says the account is out of
// credit. So quota exhaustion is recognised ONLY from an upstream body that
// actually claims it (OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED`,
// or plain "exceeded your current quota"/quota/billing wording); every other
// 429 is reported as the rate limit it is. Anthropic's API has no quota concept
// at all — every Anthropic 429 is a per-minute rate_limit_error whose envelope
// is {type:'error', error:{type:'rate_limit_error', message}} (SDKs expose the
// whole envelope as error.error, so the real type sits at error.error.error.type)
// — so under the old `status === 429` rule an Anthropic user could never avoid
// the false "free-tier quota exhausted" message.
function errorSignals(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const upstreamType = error && (error.error?.error?.type || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  return { status, code, upstreamType, text: `${rawMessage} ${code || ''} ${upstreamType || ''}`.toLowerCase() };
}

// The two upstream codes that mean "this is a burst/per-minute limit", never
// "your account is empty".
function hasRateLimitSignal({ code, upstreamType }) {
  return code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error';
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a quota failure instead of drifting independently.
function isQuotaError(error) {
  const signals = errorSignals(error);
  const { code, upstreamType, text } = signals;
  if (code === 'insufficient_quota' || code === 'RESOURCE_EXHAUSTED' ||
      upstreamType === 'insufficient_quota' || upstreamType === 'RESOURCE_EXHAUSTED') return true;
  if (hasRateLimitSignal(signals)) return false;
  return /insufficient_quota|resource_exhausted|exceeded your current quota|\bquota\b|\bbilling\b/i.test(text);
}

// Everything else that 429s (including a bare 429 with no body at all, which is
// what most providers send under load) is a rate limit, not exhaustion.
function isRateLimitError(error) {
  if (isQuotaError(error)) return false;
  const signals = errorSignals(error);
  const { status, code, text } = signals;
  return status === 429 || code === 429 || hasRateLimitSignal(signals) ||
    /\b429\b|too many requests|rate limit/i.test(text);
}

// An own provider refused the key itself: OpenAI/Groq/DeepSeek/Anthropic
// answer 401 ("Incorrect API key provided", invalid_api_key,
// authentication_error); Gemini answers 400 "API key not valid". A 403
// alone is not enough (it also means "no access to this model").
function isAuthError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${code || ''}`.toLowerCase();
  if (status === 401) return true;
  return /incorrect api key|invalid[ _-]?api[ _-]?key|invalid x-api-key|api key not valid|api_key_invalid|authentication_error/.test(text);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Structured errors for publik so main.js can offer a button, not just a sentence.
function publikError(message, action) {
  const e = new Error(message);
  e.action = action || null;
  return e;
}

function isConnectionError(error) {
  const name = error && error.name;
  const text = (error && (error.message || String(error))) || '';
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|connection error|aborted/i.test(text);
}

// publik gateway failures, mapped BEFORE isQuotaError: its regex matches
// "billing"/"quota" in message text and the generic 429 copy tells the user to
// "add billing to your publik API account", which is wrong for publik. Reads
// the openai SDK's APIError shape (status, error = the envelope's inner
// object, headers) and falls through (null) for anything not publik-specific.
function describePublikError(error, model) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const body = error && (error.error || error.response?.data?.error || null);
  const headers = error && error.headers;
  const retryAfter = headers ? (typeof headers.get === 'function' ? headers.get('retry-after') : (headers['retry-after'] || headers['Retry-After'])) : null;
  if (!status && !isConnectionError(error)) return null;
  const described = publik.describeGatewayError({ status, body, model, retryAfter });
  return described ? publikError(described.message, described.action) : null;
}

function formatProviderErrorMessage(error, provider, model) {
  // An empty or cut answer already carries its plain sentence (settleAnswer).
  if (error && error.emptyAnswer) return error;
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (provider === PUBLIK_PROVIDER) {
    const described = describePublikError(error, model);
    if (described) return described;
  }

  // A bad own key: one plain sentence, never the provider's raw 401 (which
  // also echoes part of the key). main.js adds "Switch to publik" and
  // "Fix my key" (src/publik.js ownKeyFailedMessage).
  if (provider !== PUBLIK_PROVIDER && isAuthError(error)) {
    const failed = new Error(`Your ${label} key did not work.`);
    failed.ownKeyFailed = { provider, providerName: label };
    return failed;
  }

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isRateLimitError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} is rate-limiting requests right now (429 Too Many Requests).${waitHint} and try again — this is a temporary per-minute/request limit, not your account running out of credit.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// Thinking models behind OpenAI-compatible APIs (routers, reasoning models) count
// hidden reasoning against the cap, same as Gemini below — measured: Sonnet via
// TokenRouter spent all 700 tokens on a "say" prompt and streamed 222 chars.
const OPENAI_THINKING_HEADROOM = { fast: 2048, smart: 4096 };
// Models that rejected max_tokens and asked for max_completion_tokens, so later
// requests skip the failed first attempt.
const usesMaxCompletionTokens = new Set();

// What a stream that ends with no usable answer says, instead of a blank
// bubble. Reasoning models think inside the output cap: when the thinking
// uses it all, the stream ends with finish_reason "length" and no text
// (Cue audit 2026-11-04: 118 of 2,675 fast-tier answers came back empty).
const LENGTH_EMPTY_MESSAGE = 'No answer this time: the model used its whole length limit on thinking and wrote nothing. Ask again, or ask a shorter question.';
const EMPTY_ANSWER_MESSAGE = 'The model sent back an empty answer. Ask again.';
const LENGTH_CUT_NOTE = '\n\n(Cut off: the answer reached its length limit.)';

function emptyAnswerError(finishReason) {
  let message = EMPTY_ANSWER_MESSAGE;
  if (finishReason === 'length') message = LENGTH_EMPTY_MESSAGE;
  else if (finishReason === 'content_filter') message = "The model's provider blocked this answer with its safety filter.";
  const error = new Error(message);
  error.emptyAnswer = true;
  error.finishReason = finishReason || null;
  return error;
}

// The end of an OpenAI-style stream: never a blank answer, and an answer cut
// at the cap says so. lengthCut 'ellipsis' (slide captions) trims the cut
// text and ends it with "…" instead of the cut-off note.
function settleAnswer(full, finishReason, onToken, lengthCut) {
  if (!String(full || '').trim()) throw emptyAnswerError(finishReason);
  if (finishReason !== 'length') return full;
  if (lengthCut === 'ellipsis') return trimCut(full) + '…';
  onToken(LENGTH_CUT_NOTE);
  return full + LENGTH_CUT_NOTE;
}

// A cut caption ends without a dangling space, comma, colon or dash.
function trimCut(text) {
  return String(text).replace(/[\s,;:\-\u2013\u2014]+$/u, '');
}

// One streamed chunk: its text (if any) and its finish reason (if any).
// Every chunk counts as activity, reasoning-only ones included, so a model
// that thinks for a while is not taken for a stalled stream. onActivity gets
// the chunk's kind: 'text', 'thinking' (reasoning only) or 'other'. The
// reasoning text itself never leaves this function.
function readChunk(part, onActivity) {
  const choice = part && part.choices && part.choices[0];
  const delta = (choice && choice.delta) || {};
  const text = delta.content || '';
  const thinking = !text && !!(delta.reasoning || delta.reasoning_content ||
    (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length));
  if (typeof onActivity === 'function') {
    try { onActivity(text ? 'text' : thinking ? 'thinking' : 'other'); } catch { /* a watchdog hook must never break the answer */ }
  }
  return { text, finish: (choice && choice.finish_reason) || '' };
}

// SDK request options that carry cue's cancel signal (none: SDK defaults).
function requestOptions(signal) {
  return signal ? { signal } : undefined;
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, onResponse, lengthCut, signal }) {
  const OpenAI = require('openai');
  const client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const open = async (limitParam) => {
    const pending = client.chat.completions.create({ model, messages, stream: true, [limitParam]: maxTokens }, requestOptions(signal));
    if (typeof onResponse === 'function' && pending && typeof pending.withResponse === 'function') {
      // The gateway stamps x-publik-* headers at admission; hand the raw
      // Response to the caller so the balance line can move before settlement.
      const { data, response } = await pending.withResponse();
      try { onResponse(response); } catch { /* a display hook must never break the answer */ }
      return data;
    }
    return pending;
  };
  let stream;
  try {
    stream = await open(usesMaxCompletionTokens.has(model) ? 'max_completion_tokens' : 'max_tokens');
  } catch (error) {
    signal?.throwIfAborted();
    // Newer OpenAI reasoning models (also via routers) 400 on max_tokens.
    if (!(error && error.status === 400 && /max_completion_tokens/.test(error.message || ''))) throw error;
    usesMaxCompletionTokens.add(model);
    stream = await open('max_completion_tokens');
  }
  let full = '';
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) { full += chunk.text; onToken(chunk.text); }
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(full, finish, onToken, lengthCut);
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, endpoint, lengthCut, signal }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens }, requestOptions(signal));
  let full = '';
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) { full += chunk.text; onToken(chunk.text); }
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(full, finish, onToken, lengthCut);
}

async function streamAnthropic({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, effort, webSearch, onToken, onActivity, signal }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(baseURL ? { apiKey, baseURL } : { apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  // Effort only takes hold with adaptive thinking, and thinking spends from max_tokens, so lift the cap.
  const strength = effort ? { thinking: { type: 'adaptive' }, output_config: { effort }, max_tokens: maxTokens + 16000 } : {};
  // Server-side web search: Anthropic runs it and the answer text still arrives as text_delta.
  const tools = webSearch ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] } : {};
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true, ...strength, ...tools }, requestOptions(signal));
  let full = '';
  let stopReason = null;
  for await (const ev of stream) {
    // Thinking streams no text for a while; any event (pings included) proves the stream is alive.
    if (typeof onActivity === 'function') onActivity();
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
  }
  if (!full) {
    throw new Error(stopReason === 'refusal'
      ? "The model's provider blocked this answer with its safety filter."
      : `The model returned an empty answer${stopReason ? ` (finish reason: ${stopReason})` : ''}.`);
  }
  return full;
}

// Gemini 3.x counts its internal "thinking" tokens against maxOutputTokens, so
// a 700-token cap was mostly eaten by reasoning and the visible answer came
// back truncated mid-sentence (measured: 3.8-flash spends ~390 thinking tokens
// on a short notes prompt by default). Fast tier: thinkingLevel "low", which
// on flash means no thinking at all (0 thought tokens, ~3x faster). Smart tier:
// leave the model's default reasoning alone. Either way, give the cap headroom
// for thoughts so the visible budget is what maxTokens says.
// (thinkingBudget: 0 is rejected by pro models and "minimal" by flash, so
// "low" is the one setting that works across the family.)
const GEMINI_THINKING_HEADROOM = { fast: 1024, smart: 4096 };
function geminiGenerationConfig({ system, maxTokens, thinking }) {
  const config = {
    systemInstruction: system,
    maxOutputTokens: maxTokens + (thinking ? GEMINI_THINKING_HEADROOM.smart : GEMINI_THINKING_HEADROOM.fast)
  };
  if (!thinking) config.thinkingConfig = { thinkingLevel: 'low' };
  return config;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, thinking, webSearch, onToken, signal }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = geminiGenerationConfig({ system, maxTokens, thinking });
  if (webSearch) config.tools = [{ googleSearch: {} }];
  if (signal) config.abortSignal = signal;
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    signal?.throwIfAborted();
    // A model that predates thinkingLevel (or a custom id that rejects it)
    // should still answer: retry once without the thinking setting.
    if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
    delete config.thinkingConfig;
    stream = await ai.models.generateContentStream({ model, contents, config });
  }
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) {
        messages.push({ role: 'user', content: t.text, images: [img.b64] });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      ...(signal ? { signal } : {})
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (e) {
        // ignore
      }
    }
  }
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (e) { }
  }
  return full;
}

// publik's tiers are reasoning models, and the thinking counts inside the
// output cap. A 700-token cap was often all thinking: 118 of 2,675 fast-tier
// answers came back empty (output 700, reasoning 700), and on 0.2.10 one
// screenshot answer in five was cut at 700 (prod audit 2026-11-04). As with
// Gemini above, the cap gets headroom for thoughts, so maxTokens stays the
// visible budget. Prod reasoning on these models: publik-fast p99 628 and max
// 960 tokens; publik-balanced p95 1,013 and p99 2,691. So publik-fast gets
// 2,048 tokens of room, and every other publik call (publik-balanced: Smart,
// and screenshot questions on the fast tier) gets 4,096. The user pays for
// the tokens used, not for the cap.
const PUBLIK_THINKING_HEADROOM = { fast: 2048, smart: 4096 };
function publikOutputCap(visibleTokens, model) {
  const room = model === publik.DEFAULT_MODELS.fast ? PUBLIK_THINKING_HEADROOM.fast : PUBLIK_THINKING_HEADROOM.smart;
  return visibleTokens + room;
}

// The publik model a screenshot question uses. On the smart tier that is the
// model already chosen. On the fast tier it is the smart alias (the user's
// Smart field, else the provisioning response's, else publik-balanced),
// unless the user typed their own Fast model: an explicit choice stands.
function publikVisionModel(settings, fastOrSmartModel) {
  if (settings.smart) return fastOrSmartModel;
  const tierModels = (settings.models || {})[PUBLIK_PROVIDER] || {};
  const fast = String(tierModels.fast || '').trim();
  if (fast && !publik.TIER_NAMES.includes(fast)) return fastOrSmartModel;
  return String(tierModels.smart || '').trim() || publik.DEFAULT_MODELS.smart;
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  let missingKey = false;
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini') {
    model = resolveGeminiModel(settings);
  }
  if (provider === PUBLIK_PROVIDER && !model) model = publik.DEFAULT_MODELS[tier];
  if (provider === 'anthropic' && DEAD_ANTHROPIC_MODEL_RE.test(model || '')) {
    model = tier === 'smart' ? CURRENT_ANTHROPIC_DEFAULT_SMART : CURRENT_ANTHROPIC_DEFAULT_FAST;
  }
  if (provider === 'deepseek' && DEAD_DEEPSEEK_MODEL_RE.test(model || '')) {
    model = /reasoner/i.test(model) ? CURRENT_DEEPSEEK_SMART_DEFAULT : CURRENT_DEEPSEEK_FAST_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';

  if (provider === PUBLIK_PROVIDER) {
    // The packaged-build default: an OpenAI-compatible endpoint with a fixed
    // base URL (the provisioning response's, else the build's) and the key the
    // install minted. Never settings.baseUrl — that is the user's Custom slot.
    const base = (settings.publik && settings.publik.baseUrl) || publik.DEFAULT_BASE_URL;
    try {
      baseURL = createCompatibleClientOptions(apiKey, base).baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!apiKey) configurationError = 'Sign in with publik to start. cue runs on your publik balance, so you need no API key.';
  } else if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    // Ollama is a local server: the field holds a URL, and no key is required.
    configurationError = `Add your ${normalizeProviderName(provider)} key in Settings.`;
    missingKey = true;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;
  const maxTokens = settings.smart ? 1400 : 700;
  // publik's fast tier encodes a screenshot too coarsely to read a real
  // screen (smoke test 2026-11-02: it named "Jira" and "Itch.io" for a
  // LinkedIn page, from ~20-40 image tokens, while publik-balanced read it
  // right). A question that carries a screenshot goes to the smart alias;
  // text-only questions stay on the fast tier.
  const visionModel = provider === PUBLIK_PROVIDER ? publikVisionModel(settings, model) : model;

  // Providers with a built-in web search tool. Anthropic only direct: a relay
  // (TokenRouter) may not forward server tools. The others have no such tool here.
  const webSearch = (provider === 'anthropic' && !String(settings.anthropicBaseUrl || '').trim()) || provider === 'gemini';

  return {
    provider, model, visionModel, apiKey, baseURL,
    ready,
    configurationError,
    missingKey,
    webSearch,
    providerName: normalizeProviderName(provider),
    async stream(params) {
      const signal = params.signal;
      signal?.throwIfAborted();
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const useModel = params && params.imageDataUrl ? visionModel : model;
      const args = { apiKey, baseURL, endpoint, model: useModel, maxTokens, thinking: !!settings.smart, ...params, turns: sanitizeTurns(params.turns) };
      args.webSearch = webSearch && !!params.webSearch;
      // An explicit maxTokens: undefined (or any non-number) falls back to the
      // default cap; it must never reach the request as NaN.
      if (!(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) args.maxTokens = maxTokens;
      if (provider === PUBLIK_PROVIDER) args.maxTokens = publikOutputCap(args.maxTokens, useModel);
      if (provider === CUSTOM_PROVIDER) args.maxTokens = args.maxTokens + OPENAI_THINKING_HEADROOM[settings.smart ? 'smart' : 'fast'];
      let streamed = false;
      for (const hook of ['onToken', 'onActivity', 'onResponse']) {
        if (typeof params[hook] === 'function') args[hook] = (...values) => { signal?.throwIfAborted(); if (hook === 'onToken') streamed = true; return params[hook](...values); };
      }
      const dispatch = async (args) => {
        if (provider === 'openai') return await streamOpenAI(args);
        if (provider === CUSTOM_PROVIDER) return await streamOpenAI(args);
        if (provider === PUBLIK_PROVIDER) return await streamOpenAI(args);
        if (provider === 'ollama') return await streamOllama(args);
        if (provider === 'groq') return await streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
        if (provider === 'cerebras') return await streamOpenAI({ ...args, baseURL: CEREBRAS_BASE_URL });
        if (provider === 'minimax') return await streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
        if (provider === 'deepseek') return await streamOpenAI({ ...args, baseURL: DEEPSEEK_BASE_URL });
        if (provider === 'anthropic') {
          // An Anthropic-format relay (e.g. TokenRouter); the SDK adds /v1 itself.
          const relay = String(settings.anthropicBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
          return await streamAnthropic({ ...args, baseURL: relay || undefined, effort: (settings.anthropicEffort || {})[tier] || undefined });
        }
        if (provider === 'gemini') return await streamGemini(args);
        if (provider === 'azure') return await streamAzure(args);
        throw new Error('unknown provider: ' + provider);
      };
      try {
        try {
          return await abortable(dispatch(args), signal);
        } catch (error) {
          signal?.throwIfAborted();
          // Web search is a bonus, never a reason to lose the answer: a provider that
          // refuses the tool (disabled for the account, not on this model) gets one retry without it.
          if (!(args.webSearch && !streamed && [400, 403, 422].includes(errorSignals(error).status))) throw error;
          return await abortable(dispatch({ ...args, webSearch: false }), signal);
        }
      } catch (error) {
        signal?.throwIfAborted();
        // publik branches return an Error carrying `.action`; the string
        // branches keep working unchanged.
        const wrapped = formatProviderErrorMessage(error, provider, useModel);
        throw wrapped instanceof Error ? wrapped : new Error(wrapped);
      }
    }
  };
}

module.exports = {
  createLLM,
  formatProviderErrorMessage,
  isAuthError,
  normalizeProviderName,
  isQuotaError,
  isNotFoundError,
  geminiGenerationConfig,
  publikOutputCap,
  PUBLIK_THINKING_HEADROOM,
  LENGTH_EMPTY_MESSAGE,
  EMPTY_ANSWER_MESSAGE,
  LENGTH_CUT_NOTE,
  resolveGeminiModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  PUBLIK_PROVIDER,
  isRateLimitError
};
