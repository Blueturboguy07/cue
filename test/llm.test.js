const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
let fakeResponseHeaders = null; // when set, create() returns an APIPromise-like with withResponse()
let fakeCreateError = null;     // when set, create() rejects with it (the SDK's APIError shape)
const originalModuleLoad = Module._load;

Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              const data = [{ choices: [{ delta: { content: 'ok' } }] }];
              if (fakeCreateError) return Promise.reject(fakeCreateError);
              if (!fakeResponseHeaders) return Promise.resolve(data);
              const headers = fakeResponseHeaders;
              const p = Promise.resolve(data);
              p.withResponse = async () => ({ data, response: { headers: { get: (k) => (k in headers ? headers[k] : null) } } });
              return p;
            }
          }
        };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM, formatProviderErrorMessage, isQuotaError, geminiGenerationConfig, CURRENT_GEMINI_DEFAULT, PUBLIK_PROVIDER, isRateLimitError } = require('../src/llm');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
  fakeResponseHeaders = null;
  fakeCreateError = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.deepEqual(capturedClientOptions, {
    apiKey: 'gateway-token',
    baseURL: 'http://127.0.0.1:18789/v1'
  });
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.deepEqual(capturedClientOptions, { apiKey: 'official-openai-key' });
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

// ---- MiniMax (PR #22) -----------------------------------------------------
// MiniMax is OpenAI-compatible and region-split, so these assert the regional
// gateway selection rather than any new transport.

function minimaxSettings(overrides) {
  return Object.assign({
    provider: 'minimax',
    smart: true,
    apiKeys: { minimax: 'test-key' },
    models: { minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' } }
  }, overrides || {});
}

test('selects the MiniMax model for the active tier and reports readiness', () => {
  const smart = createLLM(minimaxSettings({ smart: true }));
  assert.equal(smart.provider, 'minimax');
  assert.equal(smart.model, 'MiniMax-M3');
  assert.equal(smart.ready, true);

  const fast = createLLM(minimaxSettings({ smart: false }));
  assert.equal(fast.model, 'MiniMax-M2.7');
});

test('routes MiniMax to the global OpenAI-compatible endpoint by default', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'global_en' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('routes MiniMax to the China endpoint when that region is selected', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'cn_zh' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimaxi.com/v1');
});

function cerebrasSettings(overrides) {
  return Object.assign({
    provider: 'cerebras',
    smart: true,
    apiKeys: { cerebras: 'csk-test' },
    models: { cerebras: { fast: 'qwen-3.8-27b', smart: 'qwen-3.8-27b' } }
  }, overrides || {});
}

test('selects the Cerebras model for the active tier and reports readiness', () => {
  const smart = createLLM(cerebrasSettings({ smart: true }));
  assert.equal(smart.provider, 'cerebras');
  assert.equal(smart.model, 'qwen-3.8-27b');
  assert.equal(smart.ready, true);

  const fast = createLLM(cerebrasSettings({ smart: false }));
  assert.equal(fast.model, 'qwen-3.8-27b');
});

test('routes Cerebras to https://api.cerebras.ai/v1', async () => {
  capturedClientOptions = null;
  const llm = createLLM(cerebrasSettings());
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.cerebras.ai/v1');
  assert.equal(capturedClientOptions.apiKey, 'csk-test');
});

// ---- DeepSeek ---------------------------------------------------------------
// DeepSeek is OpenAI-compatible with a single fixed endpoint, so this asserts
// the model/readiness plumbing and the baseURL used to reach it.

function deepseekSettings(overrides) {
  return Object.assign({
    provider: 'deepseek',
    smart: true,
    apiKeys: { deepseek: 'test-key' },
    models: { deepseek: { fast: 'deepseek-flash', smart: 'deepseek-v4-pro' } }
  }, overrides || {});
}

test('selects the DeepSeek model for the active tier and reports readiness', () => {
  const smart = createLLM(deepseekSettings({ smart: true }));
  assert.equal(smart.provider, 'deepseek');
  assert.equal(smart.model, 'deepseek-v4-pro');
  assert.equal(smart.ready, true);

  const fast = createLLM(deepseekSettings({ smart: false }));
  assert.equal(fast.model, 'deepseek-flash');
});

// deepseek-chat/deepseek-reasoner were retired 2026-07-24 and now 404; a
// settings file saved before this fix can still have one persisted on disk.
test('self-heals a settings file saved with the retired deepseek-chat/deepseek-reasoner aliases', () => {
  const fast = createLLM(deepseekSettings({
    smart: false,
    models: { deepseek: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' } }
  }));
  assert.equal(fast.model, 'deepseek-flash');

  const smart = createLLM(deepseekSettings({
    smart: true,
    models: { deepseek: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' } }
  }));
  assert.equal(smart.model, 'deepseek-v4-pro');
});

test('routes DeepSeek to its OpenAI-compatible endpoint', async () => {
  capturedClientOptions = null;
  const llm = createLLM(deepseekSettings());
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.deepseek.com');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('reports a configuration error when the DeepSeek key is missing', () => {
  const llm = createLLM(deepseekSettings({ apiKeys: { deepseek: '' } }));
  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Add your deepseek API key/);
});

// ---- Gemini 404/429 error mapping ------------------------------------------
// Reproduces the exact bug-report clusters: "Error: got status: 404 Not Found.
// {"error":{"message":"exception parsing response","code":404,"status":"Not
// Found"}}" (dead/misspelled model) and 429 quota exhaustion, and asserts they
// come out as actionable in-app messages instead of the raw provider JSON.

function geminiApiError({ status, body }) {
  const err = new Error(`got status: ${status}. ${JSON.stringify(body)}`);
  err.name = 'ApiError';
  err.status = status; // matches @google/genai's ApiError shape
  return err;
}

test('formatProviderErrorMessage: maps a Gemini 404 to an actionable "model unavailable" message', () => {
  const error = geminiApiError({
    status: 404,
    body: { error: { message: 'exception parsing response', code: 404, status: 'Not Found' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.0-flash');
  assert.match(message, /Gemini/);
  assert.match(message, /model "gemini-2\.0-flash"/);
  assert.match(message, /unavailable \(404\)/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /exception parsing response/);
});

test('formatProviderErrorMessage: 404 message still works without a model id', () => {
  const error = geminiApiError({ status: 404, body: { error: { message: 'not found', code: 404 } } });
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI model is unavailable \(404\)/);
});

test('formatProviderErrorMessage: maps a Gemini 429 to a free-tier quota message', () => {
  const error = geminiApiError({
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 429, status: 'RESOURCE_EXHAUSTED' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-3.6-flash');
  assert.match(message, /Gemini free-tier quota exhausted \(429/);
  assert.match(message, /billing/);
  assert.doesNotMatch(message, /RESOURCE_EXHAUSTED/);
});

test('formatProviderErrorMessage: surfaces retry-after when the 429 body carries a RetryInfo delay', () => {
  const error = geminiApiError({
    status: 429,
    body: {
      error: {
        message: 'Resource exhausted',
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }]
      }
    }
  });
  const message = formatProviderErrorMessage(error, 'gemini');
  assert.match(message, /Wait about 38s/);
});

test('formatProviderErrorMessage: 429 without a retry delay falls back to a generic wait hint', () => {
  const error = new Error('429 Too Many Requests');
  error.status = 429;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /Wait a moment/);
});

test('formatProviderErrorMessage: an OpenAI-style quota 429 (no numeric status) is still recognized', () => {
  // Matches the literal text one of the bug reports pasted in.
  const error = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

test('formatProviderErrorMessage: an unrecognized error passes its raw message through unchanged', () => {
  const error = new Error('socket hang up');
  assert.equal(formatProviderErrorMessage(error, 'anthropic'), 'socket hang up');
});

test('isQuotaError: agrees with formatProviderErrorMessage on what counts as quota', () => {
  // A 429 whose body says nothing about quota is a rate limit, not exhaustion
  // (cue-quota-exhausted-429-false-positive): it used to be classified as quota
  // purely because the status was 429, which is what produced the false
  // "free-tier quota exhausted" message on accounts that had plenty of credit.
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: {} })), false);
  assert.equal(isRateLimitError(geminiApiError({ status: 429, body: {} })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 404, body: {} })), false);
  assert.equal(isQuotaError(new Error('insufficient_quota')), true);
});

// ---- Anthropic/OpenAI genuine rate limit vs. quota exhaustion --------------
// Regression coverage for cue-quota-exhausted-429-false-positive: a plain
// per-minute/RPM rate limit is NOT an account-exhaustion signal and must not
// be reported to the user as "free-tier quota exhausted". Anthropic's API
// has no separate "quota" concept at all -- every Anthropic 429 is a
// rate_limit_error -- so before this fix an Anthropic user could NEVER avoid
// the false "quota exhausted" message.

function anthropicRateLimitError() {
  // Shape matches @anthropic-ai/sdk's RateLimitError: status 429, with
  // error.error holding the parsed {type:'error', error:{type:'rate_limit_error', ...}} envelope.
  const body = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' } };
  const e = new Error(`429 ${JSON.stringify(body)}`);
  e.status = 429;
  e.error = body;
  return e;
}

function openaiRateLimitExceededError() {
  // Shape matches the openai SDK's APIError for an RPM burst on a brand-new
  // key: code 'rate_limit_exceeded', NOT 'insufficient_quota'.
  const body = { message: 'Rate limit reached for gpt-4o-mini on requests per min (RPM): Limit 3, Used 3, Requested 1.', type: 'requests', code: 'rate_limit_exceeded' };
  const e = new Error(`429 ${JSON.stringify({ error: body })}`);
  e.status = 429;
  e.code = 'rate_limit_exceeded';
  e.error = body;
  return e;
}

test('isQuotaError: an Anthropic rate_limit_error (per-minute, not account exhaustion) is not quota', () => {
  assert.equal(isQuotaError(anthropicRateLimitError()), false);
});

test('isQuotaError: an OpenAI rate_limit_exceeded burst (not insufficient_quota) is not quota', () => {
  assert.equal(isQuotaError(openaiRateLimitExceededError()), false);
});

test('formatProviderErrorMessage: an Anthropic rate_limit_error gets its own message, never "quota exhausted"', () => {
  const message = formatProviderErrorMessage(anthropicRateLimitError(), 'anthropic', 'claude-3-5-haiku-latest');
  assert.doesNotMatch(message, /free-tier quota exhausted/i);
  assert.match(message, /rate-limiting/i);
});

test('formatProviderErrorMessage: an OpenAI rate_limit_exceeded burst gets its own message, never "quota exhausted"', () => {
  const message = formatProviderErrorMessage(openaiRateLimitExceededError(), 'openai', 'gpt-4o-mini');
  assert.doesNotMatch(message, /free-tier quota exhausted/i);
  assert.match(message, /rate-limiting/i);
});

test('formatProviderErrorMessage: a genuine OpenAI insufficient_quota error still shows quota-exhausted', () => {
  const body = { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' };
  const e = new Error(`429 ${JSON.stringify({ error: body })}`);
  e.status = 429;
  e.code = 'insufficient_quota';
  e.error = body;
  const message = formatProviderErrorMessage(e, 'openai', 'gpt-4o-mini');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

// ---- Gemini model selection / self-healing migration -----------------------

function geminiSettings(overrides) {
  return Object.assign({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' }
  }, overrides || {});
}

test('createLLM: falls back to CURRENT_GEMINI_DEFAULT when no model is configured', () => {
  const llm = createLLM(geminiSettings({ models: {} }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
  assert.equal(llm.ready, true);
});

test('createLLM: a fresh install (store.js DEFAULTS shape) resolves to the current default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.1-pro-preview' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.5-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' } },
    smart: true
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.0-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a legacy gemini-1.5-* model saved before the 2.0-flash migration existed', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' } },
    smart: true
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: leaves a user-chosen current Gemini model alone', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } }
  }));
  assert.equal(llm.model, 'gemini-3.5-flash');
});

// ---- publik API (packaged-build default) ----------------------------------

const PUBLIK_KEY = 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32);

function publikSettings(overrides = {}) {
  return {
    provider: 'publik',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1', // the user's Custom slot — must never leak into publik
    apiKeys: { openai: '', custom: 'gateway-token', publik: PUBLIK_KEY },
    publik: { baseUrl: '' },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' }, custom: { fast: 'x', smart: 'x' } },
    ...overrides
  };
}

test('publik: routes through the publik base URL with the minted key, never the Custom base URL', async () => {
  const llm = createLLM(publikSettings());
  assert.equal(PUBLIK_PROVIDER, 'publik');
  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'publik-fast');
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.deepEqual(capturedClientOptions, { apiKey: PUBLIK_KEY, baseURL: 'https://publikhq.com/api/v1' });
  assert.equal(capturedCompletionRequest.model, 'publik-fast');
});

test('publik: honours the provisioning response base_url and the smart tier alias', async () => {
  const llm = createLLM(publikSettings({ smart: true, publik: { baseUrl: 'https://publikhq.com/api/v1-next/' } }));
  assert.equal(llm.model, 'publik-balanced');
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://publikhq.com/api/v1-next');
});

test('publik: cleared model fields fall back to the per-tier aliases', () => {
  assert.equal(createLLM(publikSettings({ models: { publik: { fast: '', smart: '' } } })).model, 'publik-fast');
  assert.equal(createLLM(publikSettings({ smart: true, models: { publik: { fast: '', smart: '' } } })).model, 'publik-balanced');
});

test('publik: missing key → not ready, "not set up", no request', () => {
  const llm = createLLM(publikSettings({ apiKeys: { publik: '' } }));
  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /publik API is not set up/);
  assert.equal(capturedClientOptions, null);
});

test('publik: the raw Response reaches onResponse so x-publik-* headers can drive the balance line', async () => {
  fakeResponseHeaders = { 'x-publik-balance': '181240', 'x-publik-claim-state': 'anonymous', 'x-publik-model': 'gpt-5.6-luna' };
  let seen = null;
  const llm = createLLM(publikSettings());
  const out = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {}, onResponse: (res) => { seen = res.headers.get('x-publik-balance'); } });
  assert.equal(out, 'ok');
  assert.equal(seen, '181240');
});

test('publik: a stub without withResponse() still streams (onResponse is optional)', async () => {
  const llm = createLLM(publikSettings());
  const out = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {}, onResponse: () => {} });
  assert.equal(out, 'ok');
});

function sdkError(status, error, headers = {}) {
  const e = new Error(`${status} ${JSON.stringify({ error })}`);
  e.name = 'APIError';
  e.status = status;      // openai v4 APIError fields
  e.error = error;        // the envelope's inner object
  e.headers = headers;
  return e;
}

test('formatProviderErrorMessage: publik 402 → Error with a single link action, not the 429 free-tier text', () => {
  const err = sdkError(402, { type: 'insufficient_credit', message: 'Not enough publik credit for this request. Check billing.', claim_state: 'anonymous', top_up_url: 'https://publikhq.com/claim/abc' });
  assert.equal(isQuotaError(err), true, 'precondition: the generic classifier WOULD misfile this as a quota error');
  const out = formatProviderErrorMessage(err, 'publik', 'publik-fast');
  assert.ok(out instanceof Error);
  assert.deepEqual(out.action, { kind: 'link', label: 'Link this computer & pick a plan', url: 'https://publikhq.com/claim/abc' });
  // CONTRACT §12.3: the response's own message is what the banner shows.
  assert.equal(out.message, 'Not enough publik credit for this request. Check billing.');
  assert.doesNotMatch(out.message, /free-tier quota|add billing/);
});

test('formatProviderErrorMessage: publik 401 key_revoked → reprovision / reconnect; 429 daily cap; 400 unknown_model', () => {
  assert.deepEqual(formatProviderErrorMessage(sdkError(401, { type: 'key_revoked', reprovision: true }), 'publik').action, { kind: 'reprovision' });
  assert.equal(formatProviderErrorMessage(sdkError(401, { type: 'key_revoked', reprovision: false }), 'publik').action.kind, 'reconnect');
  const cap = formatProviderErrorMessage(sdkError(429, { type: 'daily_cap_reached', claim_state: 'anonymous', claim_url: 'https://publikhq.com/claim/abc' }, { 'retry-after': '1800' }), 'publik');
  assert.match(cap.message, /daily publik API spending cap — it resets in 30 minutes/);
  const unknown = formatProviderErrorMessage(sdkError(400, { type: 'unknown_model' }), 'publik', 'gpt-9');
  assert.match(unknown.message, /does not serve "gpt-9"/);
  assert.equal(unknown.action, null);
});

test('formatProviderErrorMessage: publik connection failure → unreachable, nothing charged', () => {
  const e = new Error('Connection error.');
  e.name = 'APIConnectionError';
  const out = formatProviderErrorMessage(e, 'publik', 'publik-fast');
  assert.match(out.message, /publik API is unreachable right now\. Nothing is being charged/);
});

test('formatProviderErrorMessage: a non-publik-specific error on publik falls through to the generic copy', () => {
  const out = formatProviderErrorMessage(sdkError(400, { type: 'invalid_request', message: 'bad request' }), 'publik', 'publik-fast');
  assert.equal(typeof out, 'string');
  assert.match(out, /bad request/);
});

test('llm.stream on publik rethrows the structured error with its action', async () => {
  fakeCreateError = sdkError(402, { type: 'insufficient_credit', claim_state: 'claimed', top_up_url: 'https://publikhq.com/dashboard/api/add', available_micros: 0 });
  const llm = createLLM(publikSettings());
  await assert.rejects(llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} }), (e) => {
    assert.equal(e.action.label, 'Add a plan or pack');
    assert.equal(e.action.url, 'https://publikhq.com/dashboard/api/add');
    // No message in the body → the local sentence that says what the link does.
    assert.match(e.message, /^publik API balance is used up \(\$0\.00 left\)\. Add a plan or a pack at the link below, or use your own key in Settings\.$/);
    return true;
  });
});

test('publik never touches the Custom provider path', async () => {
  const llm = createLLM(createCustomSettings());
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.deepEqual(capturedClientOptions, { apiKey: 'gateway-token', baseURL: 'http://127.0.0.1:18789/v1' });
});

// A 429 carrying NO quota signal at all is the shape most providers send under
// load, and it is the smallest input that used to produce the false message
// (REGION.json's minimal_repro for cue-quota-exhausted-429-false-positive).
test('formatProviderErrorMessage: a bare 429 with no upstream body is a rate limit, not quota exhaustion', () => {
  const message = formatProviderErrorMessage({ status: 429 }, 'anthropic', 'claude-3-5-haiku-latest');
  assert.doesNotMatch(message, /free-tier quota exhausted/i);
  assert.match(message, /rate-limiting/i);
  assert.equal(isQuotaError({ status: 429 }), false);
});

test('formatProviderErrorMessage: an Anthropic 429 with a non-rate-limit body is still never quota exhaustion', () => {
  // Anthropic has no quota concept, so no Anthropic 429 body can justify the
  // quota copy — not overloaded_error, not an unrecognized future type.
  const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
  const e = new Error(`429 ${JSON.stringify(body)}`);
  e.status = 429;
  e.error = body;
  const message = formatProviderErrorMessage(e, 'anthropic');
  assert.doesNotMatch(message, /free-tier quota exhausted/i);
  assert.match(message, /rate-limiting/i);
});

test('isRateLimitError: a genuine quota error is never also a rate limit, and non-429s are neither', () => {
  const quota = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  assert.equal(isQuotaError(quota), true);
  assert.equal(isRateLimitError(quota), false);
  assert.equal(isRateLimitError(new Error('socket hang up')), false);
  assert.equal(isRateLimitError(geminiApiError({ status: 404, body: {} })), false);
});

test('createLLM: self-heals gemini-2.5-* , which Google closed to new API keys', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash-lite' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

// Gemini 3.x bills thinking tokens against maxOutputTokens; the visible answer
// must keep the budget the caller asked for.
test('geminiGenerationConfig: fast tier turns thinking down and keeps headroom for it', () => {
  const cfg = geminiGenerationConfig({ system: 'sys', maxTokens: 700, thinking: false });
  assert.equal(cfg.systemInstruction, 'sys');
  assert.deepEqual(cfg.thinkingConfig, { thinkingLevel: 'low' });
  assert.ok(cfg.maxOutputTokens >= 700 + 1024, `fast cap ${cfg.maxOutputTokens} leaves no room for thoughts`);
});

test('geminiGenerationConfig: smart tier keeps the model default reasoning with a larger cap', () => {
  const cfg = geminiGenerationConfig({ system: 'sys', maxTokens: 1400, thinking: true });
  assert.equal(cfg.thinkingConfig, undefined);
  assert.ok(cfg.maxOutputTokens >= 1400 + 4096);
});

// Issue #63: OpenAI's reasoning models (GPT-5, o-series) reject max_tokens on
// Chat Completions with "Unsupported parameter: 'max_tokens'".
function openAISettings(model, overrides = {}) {
  return { provider: 'openai', smart: false, apiKeys: { openai: 'sk-test' }, models: { openai: { fast: model, smart: model } }, ...overrides };
}

test('OpenAI requests send max_completion_tokens, never max_tokens', async () => {
  await createLLM(openAISettings('gpt-4o-mini')).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken() {} });
  assert.equal(capturedCompletionRequest.max_tokens, undefined);
  assert.ok(capturedCompletionRequest.max_completion_tokens > 0);
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined, 'non-reasoning models get no effort parameter');
});

test('GPT-5 and o-series get room to reason and an effort level (Smart raises it)', async () => {
  for (const model of ['gpt-5', 'gpt-5-mini', 'o4-mini']) {
    await createLLM(openAISettings(model)).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], maxTokens: 700, onToken() {} });
    assert.equal(capturedCompletionRequest.max_tokens, undefined, model);
    assert.ok(capturedCompletionRequest.max_completion_tokens > 700, model + ' needs headroom for reasoning tokens');
    assert.equal(capturedCompletionRequest.reasoning_effort, 'low', model);
  }
  await createLLM(openAISettings('gpt-5', { smart: true })).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken() {} });
  assert.equal(capturedCompletionRequest.reasoning_effort, 'medium');
  await createLLM(openAISettings('gpt-5-chat-latest')).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken() {} });
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined, 'gpt-5-chat is not a reasoning model');
});

test('OpenAI-compatible providers keep max_tokens', async () => {
  await createLLM(createCustomSettings()).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken() {} });
  assert.ok(capturedCompletionRequest.max_tokens > 0);
  assert.equal(capturedCompletionRequest.max_completion_tokens, undefined);
});
