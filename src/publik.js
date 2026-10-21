// publik API provisioning for the packaged build. No SDK, no dependencies:
// one POST at first launch (after the disclosure is accepted), one GET for the
// balance line, and a public app token that release.yml bakes into
// src/publik-build.json. The minted key lives in cue-data.json under
// apiKeys.publik like every other provider key; the renderer never sees it.
//
// Everything Electron-specific (app version, platform, userData) is passed in
// by main.js so this file runs under plain `node --test`.
//
// Contract: ~/publik-api-research/CONTRACT.md §1, §3.2, §5.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PUBLIK_PROVIDER = 'publik';
const PROVIDER_LABEL = 'publik API';
const DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';
const ALLOWED_LINK_ORIGIN = 'https://publikhq.com';
// Tier aliases. cue's "smart" toggle lands on the balanced tier because an
// anonymous install cannot use publik-smart (402 model_requires_claim). The
// provisioning response's `models` block overrides these.
const DEFAULT_MODELS = { fast: 'publik-fast', smart: 'publik-balanced' };
const TIER_NAMES = ['publik-fast', 'publik-balanced', 'publik-smart'];
const LINKS = {
  pricing: 'https://publikhq.com/developers#plans',
  terms: 'https://publikhq.com/terms#api',
  dashboard: 'https://publikhq.com/dashboard/api'
};
const KEY_RE = /^pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}$/;
const PROVISION_TIMEOUT_MS = 15000;
const WALLET_TIMEOUT_MS = 10000;
const BYO = 'or use your own key in Settings.';

// Final in-app copy (R21 §4). Rules: "publik API" everywhere; dollars, never
// tokens; the rate and the monthly figure, never an hourly estimate; the
// starter amount is rendered from the server's response, never hardcoded.
const COPY = {
  label: PROVIDER_LABEL,
  cost: 'Every request is priced per use at 50% of the model\'s published list price. Most people spend under $2 a month.',
  dataPath: 'Your prompts and screenshots go through publik\'s servers to a shared model account. publik never trains on them and does not store them. You can switch to your own key at any time.',
  disclosure: {
    title: 'cue uses publik API',
    intro: 'cue needs an AI model to work. By default it runs on publik API, so you need no key of your own.',
    cost: 'Every request is priced per use at 50% of the model\'s published list price, from your publik balance. A new computer starts at $0.00. Linking this computer to your publik account gives $0.05 of free use, once. Most people spend under $2 a month. You can see every charge in the app and at publikhq.com.',
    dataPath: 'Your prompts and screenshots go through publik\'s servers to a shared model account. publik never trains on them and does not store them. You can switch to your own key at any time in Settings.',
    accept: 'Continue with publik API',
    decline: 'Use my own key instead',
    terms: 'By continuing you agree to the publik API terms.'
  },
  // CONTRACT §12 (founder, 2026-09-19): the one justification for charging,
  // from publik's lib/publik-api/why-it-costs.ts. Same sentence under the
  // first-run card, behind the settings toggle and nowhere else — never a
  // new pricing claim.
  whyItCosts: 'A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider\'s list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.',
  whyItCostsToggle: 'Why it costs money',
  cta: {
    cardTitle: 'publik API is set up',
    starterSuffix: 'of free starter usage',      // "$0.05 of free starter usage" — the amount comes from a linked-account mint response (an unlinked install's starter is $0.00)
    link: 'Link this computer & pick a plan',     // anonymous → claim_url
    pickPlan: 'Pick a plan',                      // claimed, no plan → dashboard
    managePlan: 'Manage plan',                    // claimed with a plan → dashboard
    addPlanOrPack: 'Add a plan or pack',          // claimed → add_credit_url (§12.2)
    later: 'Later'
  }
};

function loadBuildConfig(file = path.join(__dirname, 'publik-build.json')) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* dev checkout without the file */ }
  // PUBLIK_APP_TOKEN in the environment wins so `npm start` can test against staging.
  const appToken = String(process.env.PUBLIK_APP_TOKEN || cfg.appToken || '').trim();
  return {
    appToken,
    appSlug: cfg.appSlug || 'cue',
    baseUrl: String(process.env.PUBLIK_API_BASE_URL || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    disclosureVersion: Math.max(1, Number(cfg.disclosureVersion) || 1),
    available: !!appToken
  };
}

/** Only publikhq.com links may be opened from gateway-supplied URLs. */
function isSafePublikLink(url) {
  try { return typeof url === 'string' && new URL(url).origin === ALLOWED_LINK_ORIGIN; } catch { return false; }
}
function safeLink(url) { return isSafePublikLink(url) ? url : null; }

function formatMicros(micros) {
  const n = Number(micros);
  if (!Number.isFinite(n)) return '';
  return n !== 0 && Math.abs(n) < 10000 ? `$${(n / 1e6).toFixed(4)}` : `$${(n / 1e6).toFixed(2)}`;
}

function formatResetTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return t - now < 6 * 24 * 3600 * 1000 ? `${day} ${hh}:${mm}` : d.toLocaleDateString();
}

function osName(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function micros(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

function gatewayError(res, body) {
  const err = body && body.error ? body.error : {};
  const e = new Error(err.message || `${PROVIDER_LABEL} request failed (${res.status}).`);
  e.status = res.status;
  e.type = err.type || '';
  e.reprovision = err.reprovision === true;
  e.retryAfter = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : 0) || null;
  return e;
}

/**
 * Mint this install's key. Called only when apiKeys.publik is empty (or the
 * key was revoked) and the disclosure has been accepted — see provisionInstall.
 *
 * POST {baseUrl}/installs   Authorization: Bearer <app token>  (+ app_token in the body)
 *   → 201 { key, key_id, base_url, models, claim_url, starter_micros, balance_micros, wallet }
 *   → 200 replay for an existing install_id: { key: null, starter_micros: 0, claim_state }
 */
async function provision({ build, installId, appVersion, platform, osVersion, arch, deviceName, fetchImpl = fetch }) {
  if (!build || !build.available) throw new Error('This build has no publik app token.');
  const body = {
    app_token: build.appToken,
    app_slug: build.appSlug,
    app_version: String(appVersion || '0.0.0').slice(0, 32),
    os: osName(platform),
    os_version: String(osVersion || '').slice(0, 64),
    arch: String(arch || ''),
    install_id: installId,
    disclosure_version: build.disclosureVersion,
    dialects: ['chat_completions']
  };
  if (deviceName) body.device_name = String(deviceName).slice(0, 120);
  const res = await timedFetch(fetchImpl, `${build.baseUrl.replace(/\/+$/, '')}/installs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${build.appToken}` },
    body: JSON.stringify(body)
  }, PROVISION_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw gatewayError(res, data);

  const wallet = data.wallet ? normalizeWallet(data.wallet) : null;
  const claimState = data.claim_state || (wallet && wallet.claimState) || 'anonymous';
  const common = {
    installId,
    baseUrl: normalizeBase(data.base_url) || build.baseUrl,
    models: pickModels(data.models),
    claimUrl: safeLink(data.claim_url) || (wallet && wallet.claimUrl) || null,
    claimCode: typeof data.claim_code === 'string' ? data.claim_code : '',
    claimState,
    starterMicros: micros(data.starter_micros) || 0,
    balanceMicros: firstMicros(data.balance_micros, data.starting_credit_micros, data.starter_micros, wallet && wallet.balanceMicros),
    wallet
  };
  if (data.key === null || data.key === undefined) {
    return { ...common, replay: true, key: null, keyId: '' };
  }
  if (typeof data.key !== 'string' || !KEY_RE.test(data.key)) {
    throw new Error(`${PROVIDER_LABEL} returned a malformed key.`);
  }
  return { ...common, replay: false, key: data.key, keyId: data.key_id || data.key.split('_')[2] };
}

function firstMicros(...values) {
  for (const v of values) { const m = micros(v); if (m !== null) return m; }
  return 0;
}

function normalizeBase(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

// The response carries { fast, balanced, smart }; cue has two tiers.
function pickModels(models) {
  const m = models && typeof models === 'object' ? models : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return {
    fast: str(m.fast) || DEFAULT_MODELS.fast,
    smart: str(m.balanced) || str(m.default) || str(m.smart) || DEFAULT_MODELS.smart
  };
}

/** GET /wallet body (CONTRACT §3.2, R21 §2.3) → the fields the app shows. */
function normalizeWallet(b) {
  const w = b && typeof b === 'object' ? b : {};
  const week = w.week && typeof w.week === 'object' ? w.week : {};
  const starter = w.starter && typeof w.starter === 'object' ? w.starter : {};
  const plan = w.plan && typeof w.plan === 'object' ? w.plan : {};
  const claimState = w.claim_state === 'claimed' ? 'claimed' : 'anonymous';
  const claimUrl = safeLink(w.claim_url);
  const addCreditUrl = safeLink(w.add_credit_url);
  return {
    claimState,
    balanceMicros: firstMicros(w.balance_micros, w.available_micros),
    starterRemainingMicros: micros(starter.remaining_micros),
    starterExpiresAt: typeof starter.expires_at === 'string' ? starter.expires_at : '',
    planId: typeof plan.id === 'string' ? plan.id : 'none',
    planLabel: typeof plan.label === 'string' ? plan.label : '',
    weekUsedMicros: micros(week.used_micros),
    weekBudgetMicros: micros(week.budget_micros),
    weekResetsAt: typeof week.resets_at === 'string' ? week.resets_at : '',
    dailyCapMicros: micros(w.daily_cap_micros),
    spentTodayMicros: micros(w.spent_today_micros),
    claimUrl,
    addCreditUrl,
    plansUrl: safeLink(w.plans_url),
    topUpUrl: safeLink(w.top_up_url) || (claimState === 'anonymous' ? claimUrl : addCreditUrl)
  };
}

async function fetchWallet({ baseUrl, apiKey, fetchImpl = fetch }) {
  const res = await timedFetch(fetchImpl, `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/wallet`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  }, WALLET_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw gatewayError(res, data);
  return normalizeWallet(data);
}

/** POST /installs/revoke with the install's own key (R21 §2.6). 204, idempotent. */
async function revokeInstall({ baseUrl, apiKey, fetchImpl = fetch }) {
  const res = await timedFetch(fetchImpl, `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/installs/revoke`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }
  }, WALLET_TIMEOUT_MS);
  if (!res.ok && res.status !== 401) throw gatewayError(res, await res.json().catch(() => ({})));
  return true;
}

/**
 * x-publik-* headers stamped on every metered call (CONTRACT §1). On a stream
 * they describe the state at admission (balance after the hold), so the app
 * reconciles from GET /wallet after the answer; still, they make the balance
 * line move immediately. Accepts a fetch Headers object or a plain object.
 */
function readGatewayHeaders(headers) {
  if (!headers) return null;
  const get = (name) => {
    let v = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    if (v === undefined && typeof headers.get !== 'function') v = headers[name.toLowerCase()];
    return v === null || v === undefined ? '' : String(v);
  };
  if (!get('x-publik-balance') && !get('x-publik-model') && !get('x-publik-request-id')) return null;
  const budget = get('x-publik-week-budget');
  return {
    requestId: get('x-publik-request-id'),
    model: get('x-publik-model'),
    balanceMicros: micros(get('x-publik-balance')),
    weekUsedMicros: micros(get('x-publik-week-used')),
    weekBudgetMicros: budget && budget !== 'none' ? micros(budget) : null,
    weekResetsAt: get('x-publik-week-resets-at'),
    claimState: get('x-publik-claim-state') === 'claimed' ? 'claimed' : (get('x-publik-claim-state') ? 'anonymous' : ''),
    starterRemainingMicros: get('x-publik-starter-remaining') ? micros(get('x-publik-starter-remaining')) : null,
    reservedMicros: micros(get('x-publik-reserved-micros')),
    chargeMicros: micros(get('x-publik-charge-micros'))
  };
}

function formatRetryAfter(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 90) return `${Math.ceil(s)} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/**
 * Map a gateway failure to the sentence cue shows and the one button it may
 * offer. Returns null for anything that is not publik-specific so the generic
 * provider formatting can run. `body` is the parsed `error` object of the
 * envelope ({type, message, top_up_url, ...}); `status` the HTTP status.
 *
 * 402 rule (CONTRACT §1): render the message plus exactly one link, top_up_url.
 */
function describeGatewayError({ status, body, model, retryAfter } = {}) {
  const err = body && typeof body === 'object' ? body : {};
  const type = String(err.type || '');
  const link = (label, url) => (isSafePublikLink(url) ? { kind: 'link', label, url } : null);

  if (status === 402) {
    const topUp = err.top_up_url;
    if (type === 'model_requires_claim') {
      return {
        message: `${PROVIDER_LABEL}: publik-smart needs a linked publik account. Link this computer to use it, pick a different model, ${BYO}`,
        action: link('Link now', topUp)
      };
    }
    // insufficient_credit (CONTRACT §12.3): the response's own message carries
    // the justification and says what the link does; the app renders it plus
    // exactly one link, top_up_url. Only when the body has no message does a
    // local sentence stand in.
    const claimed = err.claim_state === 'claimed';
    const fallback = claimed
      ? `${PROVIDER_LABEL} balance is used up (${formatMicros(err.available_micros || 0)} left). Add a plan or a pack at the link below, ${BYO}`
      : `${PROVIDER_LABEL}: your balance is too low for this request. Link this computer to your publik account at the link below for $0.05 of free use, pick a plan there, ${BYO}`;
    const message = typeof err.message === 'string' && err.message.trim() ? err.message.trim() : fallback;
    return { message, action: link(claimed ? 'Add a plan or pack' : 'Link this computer & pick a plan', topUp), fromResponse: message !== fallback };
  }
  if (status === 401) {
    if (type === 'key_revoked' && err.reprovision === true) {
      return {
        message: `This computer's ${PROVIDER_LABEL} key was retired after a long idle stretch. cue is reconnecting — ask again in a moment, ${BYO}`,
        action: { kind: 'reprovision' }
      };
    }
    if (type === 'key_revoked') {
      return {
        message: `${PROVIDER_LABEL} is disconnected. This computer was removed from your publik account. Reconnect to set it up again, ${BYO}`,
        action: { kind: 'reconnect', label: 'Reconnect' }
      };
    }
    return {
      message: `${PROVIDER_LABEL} did not accept this computer's key. Reconnect to set it up again, ${BYO}`,
      action: { kind: 'reconnect', label: 'Reconnect' }
    };
  }
  if (status === 429) {
    const wait = formatRetryAfter(retryAfter);
    if (type === 'daily_cap_reached') {
      return {
        message: `This computer reached its daily ${PROVIDER_LABEL} spending cap${wait ? ` — it resets in ${wait}` : ' — it resets at midnight UTC'}. Link it to your publik account for a higher cap, ${BYO}`,
        action: err.claim_state !== 'claimed' ? link('Link now', err.claim_url) : null
      };
    }
    if (type === 'week_budget_reached') {
      return {
        message: `Your publik plan's usage for this week is used up${wait ? ` — it resets in ${wait}` : ''}. Add credit to keep going, ${BYO}`,
        action: link('Add credit', err.add_credit_url)
      };
    }
    return { message: `${PROVIDER_LABEL} is busy right now. Wait ${wait || 'a moment'} and try again, ${BYO}`, action: null };
  }
  if ((status === 400 && type === 'unknown_model') || status === 404) {
    return {
      message: `${PROVIDER_LABEL} does not serve "${model || 'that model'}". Clear the Fast/Smart fields in Settings to use publik's defaults (${TIER_NAMES.join(', ')}), ${BYO}`,
      action: null
    };
  }
  if (status === 413) {
    return { message: `That request was too large for ${PROVIDER_LABEL}. Try again with less on screen, ${BYO}`, action: null };
  }
  if (status === 503 || status === 502 || status === 504 || !status) {
    return {
      message: `${PROVIDER_LABEL} is unreachable right now. Nothing is being charged. Try again in a minute, ${BYO}`,
      action: null
    };
  }
  return null;
}

/**
 * The settings-panel status line (R21 §4.1).
 *   anonymous, unlinked (starter is always $0.00): "Ready · $0.18 left"
 *   claimed:   "Linked to your publik account · $3.12 left · This week $1.20 of $4.62 · Resets Thu 12:04"
 *   claimed, no plan: "... · $3.12 left · $0.68 used this week"
 */
function balanceLine(p, now = Date.now()) {
  if (!p || !p.connected) return '';
  const w = p.wallet || {};
  const left = formatMicros(p.balanceMicros === null || p.balanceMicros === undefined ? w.balanceMicros : p.balanceMicros);
  if (!left) return 'Ready';
  if ((w.claimState || p.claimState) !== 'claimed') {
    return p.starterMicros > 0 ? `Ready · ${left} left of ${formatMicros(p.starterMicros)} free starter usage` : `Ready · ${left} left`;
  }
  const parts = ['Linked to your publik account', `${left} left`];
  if (w.weekBudgetMicros) {
    parts.push(`This week ${formatMicros(w.weekUsedMicros || 0)} of ${formatMicros(w.weekBudgetMicros)}`);
    const reset = formatResetTime(w.weekResetsAt, now);
    if (reset) parts.push(`Resets ${reset}`);
  } else if (w.weekUsedMicros !== null && w.weekUsedMicros !== undefined) {
    parts.push(`${formatMicros(w.weekUsedMicros)} used this week`);
  }
  return parts.join(' · ');
}

// ---- CONTRACT §12: the in-app CTA ----------------------------------------
// Pure views over the redacted publik state (main.js publikState()). The
// renderer paints exactly what these return, so the copy and the link rules
// are testable without a DOM.

/** "$0.05 of free starter usage" — from a linked-account mint response, never hardcoded (an unlinked install's starter is $0.00). */
function starterLine(p) {
  const starter = Number(p && p.starterMicros) || 0;
  const balance = p && p.balanceMicros !== null && p.balanceMicros !== undefined ? Number(p.balanceMicros) : null;
  if (starter > 0) {
    if (balance !== null && Number.isFinite(balance) && balance < starter) {
      return `${formatMicros(balance)} left of ${formatMicros(starter)} ${COPY.cta.starterSuffix}`;
    }
    return `${formatMicros(starter)} ${COPY.cta.starterSuffix}`;
  }
  if (balance !== null && Number.isFinite(balance)) return `${formatMicros(balance)} of publik API usage available`;
  return '';
}

/**
 * The first-run card, shown once right after POST /installs succeeds (§12.1):
 * (a) balance line, (b) the justification, (c) the primary button that opens
 * claim_url — only a publikhq.com link ever becomes a button — and "Later",
 * which keeps the key and the balance and changes nothing else.
 */
function ctaView(p) {
  if (!p || !p.connected) return null;
  const url = safeLink(p.claimUrl);
  const claimed = (p.claimState || 'anonymous') === 'claimed';
  return {
    title: COPY.cta.cardTitle,
    balance: starterLine(p),
    why: COPY.whyItCosts,
    primary: !claimed && url ? { label: COPY.cta.link, url } : null,
    secondary: { label: COPY.cta.later }
  };
}

/**
 * The same button on the settings card: anonymous → "Link this computer &
 * pick a plan" (claim_url); claimed with no plan → "Pick a plan"; claimed with
 * a plan → "Manage plan" — both on the dashboard. Null when there is nothing
 * safe to link to.
 */
function settingsCta(p) {
  if (!p || !p.connected || p.revoked) return null;
  const w = p.wallet || {};
  const claimed = ((w.claimState || p.claimState) || 'anonymous') === 'claimed';
  if (!claimed) {
    const url = safeLink(p.claimUrl);
    return url ? { label: COPY.cta.link, url } : null;
  }
  const hasPlan = !!(w.planId && w.planId !== 'none');
  return { label: hasPlan ? COPY.cta.managePlan : COPY.cta.pickPlan, url: LINKS.dashboard };
}

const LOW_STARTER_FRACTION = 0.2;

/**
 * Below 20% of the starter left, while anonymous and on no plan: one
 * non-blocking banner, one link (top_up_url). Null otherwise.
 */
function lowStarterNotice(p) {
  if (!p || !p.connected || p.revoked) return null;
  const w = p.wallet || {};
  if (((w.claimState || p.claimState) || 'anonymous') === 'claimed') return null;
  const starter = Number(p.starterMicros) || 0;
  if (starter <= 0) return null;
  const remaining = w.starterRemainingMicros !== null && w.starterRemainingMicros !== undefined
    ? Number(w.starterRemainingMicros)
    : (p.balanceMicros !== null && p.balanceMicros !== undefined ? Number(p.balanceMicros) : null);
  if (remaining === null || !Number.isFinite(remaining) || remaining >= starter * LOW_STARTER_FRACTION) return null;
  const url = safeLink(p.topUpUrl) || safeLink(w.topUpUrl) || safeLink(p.claimUrl);
  return {
    message: `${formatMicros(Math.max(0, remaining))} of your ${formatMicros(starter)} free starter usage is left. Link this computer and pick a plan to keep going, ${BYO}`,
    action: url ? { kind: 'link', label: COPY.cta.link, url } : null,
    remainingMicros: Math.max(0, remaining)
  };
}

/**
 * What publik:open may hand to the system browser: the requested link when it
 * is on publikhq.com, else the stored fallback when that is, else nothing.
 * A link off publikhq.com is dropped, never rewritten to a third origin.
 */
function resolveOpenTarget(url, fallback) {
  return safeLink(url) || safeLink(fallback) || null;
}

/** "Later" (and the primary button): the card was seen; the key stays put. */
function markCardSeen(store) {
  const s = store.getSettings();
  const before = s.apiKeys.publik;
  store.setPublik({ cardShown: true });
  const after = store.getSettings();
  if (after.apiKeys.publik !== before) throw new Error('markCardSeen must not touch the key');
  return after;
}

/**
 * The provisioning flow main.js runs after the disclosure is accepted (and on
 * Reconnect). `store` is the app's settings store: getSettings(), setPublik(),
 * setSettings(). Rules:
 *   - never mint twice for a live key;
 *   - a 200 replay with no usable credential on disk, or a 403 install_revoked, mints a fresh install_id once;
 *   - only apiKeys.publik and publik.* are written — no user-entered key is
 *     ever touched, and the provider is not switched here.
 */
async function provisionInstall({ build, store, device = {}, fetchImpl = fetch, log = () => {} }) {
  const s = store.getSettings();
  if (s.apiKeys.publik && !s.publik.revoked) return { ok: true, minted: false };
  let installId = s.publik.installId || randomUUID();
  let mintedFresh = false;
  for (;;) {
    let r;
    try {
      r = await provision({ build, installId, fetchImpl, ...device });
    } catch (e) {
      // The owner disconnected this install on the dashboard: the server will
      // never serve it again, so Reconnect starts a new install once.
      if (e.type === 'install_revoked' && !mintedFresh) { installId = randomUUID(); mintedFresh = true; continue; }
      store.setPublik({ installId, lastError: e.message });
      log({ level: 'error', event: 'publik_provision_failed', msg: e.message, context: { status: e.status || null, type: e.type || '' } });
      return { ok: false, error: e };
    }
    if (r.replay) {
      if ((!s.apiKeys.publik || s.publik.revoked) && !mintedFresh) { installId = randomUUID(); mintedFresh = true; continue; }
      const e = new Error(`${PROVIDER_LABEL} could not set up this computer. Reconnect to try again, ${BYO}`);
      store.setPublik({ installId, lastError: e.message });
      log({ level: 'error', event: 'publik_provision_replayed', msg: 'replay without a key', context: {} });
      return { ok: false, error: e };
    }
    store.setPublik({
      apiKey: r.key, installId, keyId: r.keyId, baseUrl: r.baseUrl, claimUrl: r.claimUrl || '', claimCode: r.claimCode,
      claimState: r.claimState, starterMicros: r.starterMicros, balanceMicros: r.balanceMicros, balanceAt: Date.now(),
      wallet: r.wallet, revoked: false, disconnected: false, lastError: '',
      // A new starter grant must be shown on the card before it is spent (§12.4).
      ...(r.starterMicros > 0 ? { cardShown: false } : {})
    });
    store.setSettings({ models: { publik: r.models } }); // aliases from the server win over the committed defaults
    log({ level: 'info', event: 'publik_provisioned', msg: r.keyId, context: { replayRecovered: mintedFresh } });
    return { ok: true, minted: true, keyId: r.keyId };
  }
}

module.exports = {
  PUBLIK_PROVIDER, PROVIDER_LABEL, DEFAULT_BASE_URL, DEFAULT_MODELS, TIER_NAMES, LINKS, COPY, KEY_RE,
  loadBuildConfig, provision, provisionInstall, fetchWallet, revokeInstall, normalizeWallet, readGatewayHeaders,
  describeGatewayError, balanceLine, isSafePublikLink, formatMicros, formatResetTime, osName, pickModels,
  starterLine, ctaView, settingsCta, lowStarterNotice, resolveOpenTarget, markCardSeen, LOW_STARTER_FRACTION,
  newInstallId: randomUUID
};
