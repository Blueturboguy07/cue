// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const { createCompatibleClientOptions } = require('./openai-compatible');
const publik = require('./publik');

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

// What a stream that ends with no usable answer says, instead of a blank
// bubble. Reasoning models think inside the output cap: when the thinking
// uses it all, the stream ends with finish_reason "length" and no text
// (Cue audit 2026-11-04: 118 of 2,675 fast-tier answers came back empty).
const LENGTH_EMPTY_MESSAGE = 'No answer this time: the model used its whole length limit on thinking and wrote nothing. Ask again, or ask a shorter question.';
const EMPTY_ANSWER_MESSAGE = 'The model sent back an empty answer. Ask again.';
const LENGTH_CUT_NOTE = '\n\n(Cut off: the answer reached its length limit.)';
// A provider's safety filter (finish_reason "content_filter", Anthropic
// "refusal", Gemini SAFETY and its kin, or a known refusal sentence in the
// text) and Gemini's RECITATION filter. Only a clean stop is a whole answer;
// a stream that ends on an error or with no finish reason at all is
// incomplete too, and says so.
const FILTER_EMPTY_MESSAGE = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const FILTER_CUT_NOTE = "\n\n(Incomplete: the AI provider's safety filter stopped this answer. Ask again with different words to get the rest.)";
const RECITATION_EMPTY_MESSAGE = 'The AI provider stopped this answer because it repeated published text. Ask again with different words.';
const RECITATION_CUT_NOTE = '\n\n(Incomplete: the AI provider stopped this answer because it repeated published text.)';
const INCOMPLETE_CUT_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';

// Every stop reason cue knows, lower-cased: OpenAI-style finish_reason,
// Anthropic stop_reason, Gemini finishReason. Anything else (error,
// FINISH_REASON_UNSPECIFIED, OTHER, no reason at all) is 'incomplete'.
const CLEAN_STOPS = new Set(['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use', 'function_call']);
const LENGTH_STOPS = new Set(['length', 'max_tokens', 'max_output_tokens', 'model_context_window_exceeded']);
const FILTER_STOPS = new Set(['content_filter', 'refusal', 'safety', 'prohibited_content', 'blocklist', 'spii', 'image_safety', 'image_prohibited_content']);
const RECITATION_STOPS = new Set(['recitation', 'image_recitation']);

function stopKind(reason, refused) {
  if (refused) return 'filter';
  const r = String(reason || '').toLowerCase();
  if (CLEAN_STOPS.has(r)) return 'clean';
  if (LENGTH_STOPS.has(r)) return 'length';
  if (FILTER_STOPS.has(r)) return 'filter';
  if (RECITATION_STOPS.has(r)) return 'recitation';
  return 'incomplete';
}

const EMPTY_MESSAGES = { length: LENGTH_EMPTY_MESSAGE, filter: FILTER_EMPTY_MESSAGE, recitation: RECITATION_EMPTY_MESSAGE };
const CUT_NOTES = { length: LENGTH_CUT_NOTE, filter: FILTER_CUT_NOTE, recitation: RECITATION_CUT_NOTE, incomplete: INCOMPLETE_CUT_NOTE };

function emptyAnswerError(kind, finishReason) {
  const error = new Error(EMPTY_MESSAGES[kind] || EMPTY_ANSWER_MESSAGE);
  error.emptyAnswer = true;
  error.filtered = kind === 'filter';
  error.stopKind = kind;
  error.finishReason = finishReason || null;
  return error;
}

// Refusal messages that a host streams as if they were the answer.
// publik-balanced (xiaomi/mimo-v2.6-pro, OpenRouter its only host) sometimes
// sends the first one as normal content, alone or glued to a partial answer
// mid-word ("...streaming of the ascendingThe request was rejected
// because..."), and then finish_reason "content_filter" (NitroAI smoke,
// 2026-11-05). Only exact provider messages are listed (the same list as
// NitroAI's src/lib/engine/refusal.ts), never "I can't help with that"
// phrases, which can be real content. A message counts only at the end of
// the answer, where a provider puts it when it stops the stream: one quoted
// inside an answer is content.
const REFUSAL_SENTENCES = [
  // Xiaomi MiMo (publik-balanced, seen 2026-11-05); Moonshot uses the same words.
  'The request was rejected because it was considered high risk',
  // Alibaba Qwen (DashScope "data_inspection_failed").
  'Input data may contain inappropriate content',
  'Output data may contain inappropriate content',
  // DeepSeek (publik-fast's fallback model).
  'Content Exists Risk',
  // Zhipu GLM (publik-fast = z-ai/glm-5.3-flash), code 1301, first sentence;
  // the notice goes on after it.
  '系统检测到输入或生成内容可能包含不安全或敏感内容'
];
// Whitespace and closing punctuation a provider may put after its message.
const REFUSAL_TAIL = /^[\s.。!！,，;；:："'”’)\]}]*$/u;
const HAN = /[\u4e00-\u9fff]/u;

// Takes the streamed text piece by piece and gives back the text that is safe
// to show. A whole refusal message, with only closing punctuation after it,
// is held until the stream ends: if the answer ends there, it is dropped and
// the answer counts as refused; if more text follows, it was content and is
// shown. A tail that could still grow into a refusal message (its start, even
// glued mid-word to the last word) is held until the next piece or the end.
function refusalFilter(sentences = REFUSAL_SENTENCES) {
  const patterns = sentences.map((sentence) => ({
    re: new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'),
    lower: sentence.toLowerCase(),
    han: HAN.test(sentence)
  }));
  let pending = '';
  let refused = false;
  // Each whole message in pending, earliest first, from index `from` on.
  function nextMatch(from) {
    let best = null;
    for (const p of patterns) {
      const m = p.re.exec(pending.slice(from));
      if (m && (!best || from + m.index < best.at)) best = { at: from + m.index, end: from + m.index + m[0].length, p };
    }
    return best;
  }
  // The answer can still end with this message: only closing punctuation
  // after it (or, for Zhipu, the rest of its own Chinese notice).
  const endsHere = (match) => {
    const rest = pending.slice(match.end);
    return REFUSAL_TAIL.test(rest) || (match.p.han && !/[A-Za-z]/.test(rest));
  };
  // The first message the answer can still end with, or null.
  function heldMatch() {
    for (let from = 0, match = nextMatch(0); match; from = match.end, match = nextMatch(from)) {
      if (endsHere(match)) return match;
    }
    return null;
  }
  function prefixLength() {
    let keep = 0;
    for (const p of patterns) {
      for (let n = Math.min(pending.length, p.lower.length); n > keep; n--) {
        if (p.lower.startsWith(pending.slice(pending.length - n).toLowerCase())) { keep = n; break; }
      }
    }
    return keep;
  }
  function take(n) {
    const out = pending.slice(0, n);
    pending = pending.slice(n);
    return out;
  }
  return {
    push(piece) {
      pending += piece;
      const held = heldMatch();
      if (held) return take(held.at);
      return take(pending.length - prefixLength());
    },
    end() {
      const held = heldMatch();
      if (!held) return take(pending.length);
      refused = true;
      const out = take(held.at);
      pending = '';
      return out;
    },
    get refused() { return refused; }
  };
}

// The visible answer of one stream: every piece goes through the refusal
// filter, and only what passes reaches onToken.
function answerText(onToken) {
  const filter = refusalFilter();
  let text = '';
  const emit = (piece) => { if (piece) { text += piece; onToken(piece); } };
  return {
    add(piece) { emit(filter.push(piece)); },
    finish() { emit(filter.end()); return { text, refused: filter.refused }; }
  };
}

// The end of a stream: never a blank answer, never a refusal sentence shown
// as the answer, and an answer that did not stop cleanly says why. lengthCut
// 'ellipsis' (slide captions, meeting notes) trims the cut text and ends it
// with "…" instead of a note.
function settleAnswer(answer, finishReason, onToken, lengthCut) {
  const { text, refused } = answer;
  const kind = stopKind(finishReason, refused);
  if (!String(text || '').trim()) throw emptyAnswerError(kind, finishReason);
  if (kind === 'clean') return text;
  if (lengthCut === 'ellipsis') return trimCut(text) + '…';
  const note = CUT_NOTES[kind];
  onToken(note);
  return text + note;
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
  // signal: when cue stops waiting (watchdog, caption timer), the request is
  // cancelled too, so the provider stops generating and billing it.
  const pending = client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens }, requestOptions(signal));
  let stream;
  if (typeof onResponse === 'function' && pending && typeof pending.withResponse === 'function') {
    // The gateway stamps x-publik-* headers at admission; hand the raw
    // Response to the caller so the balance line can move before settlement.
    const { data, response } = await pending.withResponse();
    try { onResponse(response); } catch { /* a display hook must never break the answer */ }
    stream = data;
  } else {
    stream = await pending;
  }
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(answer.finish(), finish, onToken, lengthCut);
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
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(answer.finish(), finish, onToken, lengthCut);
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, lengthCut, signal }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
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
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true }, requestOptions(signal));
  // stop_reason comes in the message_delta event: end_turn, max_tokens,
  // refusal, ... A stream without it did not finish.
  const answer = answerText(onToken);
  let stop = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') answer.add(ev.delta.text);
    else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
  }
  return settleAnswer(answer.finish(), stop, onToken, lengthCut);
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

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, thinking, onToken, lengthCut, signal }) {
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
  if (signal) config.abortSignal = signal;
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    // A model that predates thinkingLevel (or a custom id that rejects it)
    // should still answer: retry once without the thinking setting.
    if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
    delete config.thinkingConfig;
    stream = await ai.models.generateContentStream({ model, contents, config });
  }
  // finishReason comes on the last candidate: STOP, MAX_TOKENS, SAFETY,
  // RECITATION, ... A blocked prompt has no candidate, only
  // promptFeedback.blockReason: the safety filter stopped it.
  const answer = answerText(onToken);
  let stop = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) answer.add(t);
    const candidate = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
    if (candidate && candidate.finishReason) stop = candidate.finishReason;
    else if (!stop && chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason) stop = 'SAFETY';
  }
  return settleAnswer(answer.finish(), stop, onToken, lengthCut);
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

  return {
    provider, model, visionModel, apiKey, baseURL,
    ready,
    configurationError,
    missingKey,
    providerName: normalizeProviderName(provider),
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const useModel = params && params.imageDataUrl ? visionModel : model;
      const args = { apiKey, baseURL, endpoint, model: useModel, maxTokens, thinking: !!settings.smart, ...params, turns: sanitizeTurns(params.turns) };
      // An explicit maxTokens: undefined (or any non-number) falls back to the
      // default cap; it must never reach the request as NaN.
      if (!(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) args.maxTokens = maxTokens;
      const visibleTokens = args.maxTokens;
      if (provider === PUBLIK_PROVIDER) args.maxTokens = publikOutputCap(visibleTokens, useModel);
      // publik branches return an Error carrying `.action`; the string
      // branches keep working unchanged.
      const wrap = (error, failedModel) => {
        const wrapped = formatProviderErrorMessage(error, provider, failedModel);
        return wrapped instanceof Error ? wrapped : new Error(wrapped);
      };
      try {
        return await streamWith(provider, args, minimaxRegion);
      } catch (error) {
        const retryModel = provider === PUBLIK_PROVIDER ? publikRefusalRetryModel(error, useModel, settings, !!args.imageDataUrl) : '';
        if (!retryModel || (args.signal && args.signal.aborted)) throw wrap(error, useModel);
        if (typeof args.onRetry === 'function') {
          try { args.onRetry({ from: useModel, to: retryModel, finishReason: error.finishReason || null }); } catch { /* a log hook must never break the answer */ }
        }
        try {
          return await streamOpenAI({ ...args, model: retryModel, maxTokens: publikOutputCap(visibleTokens, retryModel) });
        } catch (retryError) {
          // The retry's own empty or refused answer says what happened to it;
          // any other failure of the retry (no credit, a network error) leaves
          // the first, honest answer: the safety filter stopped it.
          if (retryError && retryError.emptyAnswer) throw wrap(retryError, retryModel);
          error.retryFailed = (retryError && retryError.message) || String(retryError);
          throw wrap(error, useModel);
        }
      }
    }
  };
}

function streamWith(provider, args, minimaxRegion) {
  if (provider === 'openai') return streamOpenAI(args);
  if (provider === CUSTOM_PROVIDER) return streamOpenAI(args);
  if (provider === PUBLIK_PROVIDER) return streamOpenAI(args);
  if (provider === 'ollama') return streamOllama(args);
  if (provider === 'groq') return streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
  if (provider === 'cerebras') return streamOpenAI({ ...args, baseURL: CEREBRAS_BASE_URL });
  if (provider === 'minimax') return streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
  if (provider === 'deepseek') return streamOpenAI({ ...args, baseURL: DEEPSEEK_BASE_URL });
  if (provider === 'anthropic') return streamAnthropic(args);
  if (provider === 'gemini') return streamGemini(args);
  if (provider === 'azure') return streamAzure(args);
  return Promise.reject(new Error('unknown provider: ' + provider));
}

// A publik-balanced answer that the safety filter stopped before any text
// showed is asked once more, on another publik tier, never in a loop. Every
// publik tier takes images (pricing/sheet.ts). publik-smart (openai/gpt-6-sol)
// reads a screenshot well, but only a linked install may use it (402
// model_requires_claim otherwise). publik-fast (z-ai/glm-5.3-flash) is open
// to every install, but it reads a screenshot too coarsely (smoke 2026-11-02),
// so an unlinked install's screenshot question is not asked again: its
// honest note stands. An answer that already showed text is not asked again
// either: the text stays, with the note.
const PUBLIK_BALANCED = 'publik-balanced';
function publikRefusalRetryModel(error, model, settings, hasImage) {
  if (!error || !error.filtered || !error.emptyAnswer) return '';
  if (model !== PUBLIK_BALANCED) return '';
  const p = (settings && settings.publik) || {};
  const claimed = ((p.wallet && p.wallet.claimState) || p.claimState) === 'claimed';
  if (claimed) return 'publik-smart';
  return hasImage ? '' : publik.DEFAULT_MODELS.fast;
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
  FILTER_EMPTY_MESSAGE,
  FILTER_CUT_NOTE,
  RECITATION_EMPTY_MESSAGE,
  RECITATION_CUT_NOTE,
  INCOMPLETE_CUT_NOTE,
  REFUSAL_SENTENCES,
  refusalFilter,
  stopKind,
  resolveGeminiModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  PUBLIK_PROVIDER,
  isRateLimitError
};
