// A free check of an own provider key at startup: each provider's "list
// models" call costs nothing and answers 401 (Gemini: 400 "API key not
// valid") for a key it does not know. It runs once per launch, only for an
// own provider with a key, and never sends a prompt, so it never spends
// money. A key with no credit still lists models, so this finds bad keys
// only; a question finds the rest (src/llm.js isAuthError).
'use strict';

const TIMEOUT_MS = 5000;

const CHECKS = {
  openai: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  groq: (key) => ({ url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  deepseek: (key) => ({ url: 'https://api.deepseek.com/models', headers: { Authorization: `Bearer ${key}` } }),
  cerebras: (key) => ({ url: 'https://api.cerebras.ai/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  anthropic: (key) => ({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
  // The key goes in a header, never in the URL.
  gemini: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': key } })
};

/**
 * Returns 'bad' when the provider says the key is not valid, 'ok' when it
 * accepts it, and 'unknown' for anything else (offline, a timeout, a 5xx,
 * a provider with no free check such as Custom, Azure, MiniMax or Ollama).
 */
async function checkOwnKey({ provider, apiKey, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const build = CHECKS[provider];
  if (!build || !apiKey) return 'unknown';
  const { url, headers } = build(apiKey);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: ctrl ? ctrl.signal : undefined });
    if (res.status === 401) return 'bad';
    if (res.ok) return 'ok';
    if (res.status === 400 || res.status === 403) {
      const text = await res.text().catch(() => '');
      if (/api key not valid|api_key_invalid|invalid[ _-]?api[ _-]?key|incorrect api key/i.test(text)) return 'bad';
    }
    return 'unknown';
  } catch (_) {
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { checkOwnKey, OWN_KEY_CHECK_PROVIDERS: Object.keys(CHECKS) };
