// CONTRACT §12 (founder, 2026-09-19): the plan CTA inside the app, right
// after publik API is set up. The card, the settings button and the
// low-starter banner are pure views in src/publik.js; these tests drive them
// through the same provisionInstall() flow main.js runs, with the fake store
// the provisioning tests use, so what is asserted is what the renderer paints.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const publik = require('../src/publik');

const TOKEN = 'pat_cue_' + 'a'.repeat(32);
const KEY = 'pk_live_' + 'k'.repeat(12) + '_' + 'x'.repeat(32);
const CLAIM_URL = 'https://publikhq.com/claim/HK7F-2QWD';
const WHY = 'A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider\'s list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.';

function build() {
  return { appToken: TOKEN, appSlug: 'cue', baseUrl: 'https://publikhq.com/api/v1', disclosureVersion: 1, available: true };
}
function fakeStore(initial = {}) {
  const data = {
    provider: 'publik',
    apiKeys: { openai: '', publik: '' },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
    publik: { installId: '', keyId: '', baseUrl: '', claimUrl: '', claimCode: '', claimState: '', starterMicros: 0, balanceMicros: null, balanceAt: 0, wallet: null, disclosureAccepted: 1, defaultApplied: true, revoked: false, disconnected: false, cardShown: false, lastError: '' },
    ...initial
  };
  return {
    data,
    getSettings: () => data,
    setSettings(patch) { if (patch.models) data.models = { ...data.models, ...patch.models }; if (patch.provider) data.provider = patch.provider; return data; },
    setPublik(patch) {
      const { apiKey, ...rest } = patch;
      if (typeof apiKey === 'string') data.apiKeys.publik = apiKey;
      data.publik = { ...data.publik, ...rest };
      return data;
    }
  };
}
function mintResponse(overrides = {}) {
  return {
    install_id: 'x', key: KEY, key_id: 'k'.repeat(12), base_url: 'https://publikhq.com/api/v1',
    models: { fast: 'publik-fast', balanced: 'publik-balanced', smart: 'publik-smart' },
    claim_code: 'HK7F-2QWD', claim_url: CLAIM_URL,
    // Policy 0059: a plain anonymous mint is $0.00. A different starter grant
    // (below) models an install minted already bound to a signed-in account.
    starter_micros: 0, balance_micros: 0, starting_credit_micros: 0,
    wallet: { claim_state: 'anonymous', balance_micros: 0, starter: { remaining_micros: 0 }, week: { used_micros: 0, budget_micros: null, resets_at: '2026-09-25T17:04:11Z' }, claim_url: CLAIM_URL },
    ...overrides
  };
}
function fetchReturning(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
}
// What main.js publikState() derives from the store — the redacted view the
// renderer gets. Mirrors main.js field for field, minus the key.
function viewOf(store) {
  const s = store.getSettings();
  const p = s.publik;
  const wallet = p.wallet || null;
  const v = {
    connected: !!s.apiKeys.publik, revoked: !!p.revoked, keyId: p.keyId,
    claimState: (wallet && wallet.claimState) || p.claimState || 'anonymous',
    claimUrl: p.claimUrl || (wallet && wallet.claimUrl) || '',
    addCreditUrl: (wallet && wallet.addCreditUrl) || '',
    topUpUrl: (wallet && wallet.topUpUrl) || p.claimUrl || '',
    starterMicros: p.starterMicros || 0, balanceMicros: p.balanceMicros, wallet, cardShown: !!p.cardShown
  };
  v.card = publik.ctaView(v);
  v.settingsCta = publik.settingsCta(v);
  v.lowStarter = publik.lowStarterNotice(v);
  return v;
}

test('the first-run card renders, in order, the balance from the mint response, the justification and the CTA with the response\'s claim_url', async () => {
  const store = fakeStore();
  const r = await publik.provisionInstall({ build: build(), store, fetchImpl: fetchReturning(201, mintResponse()) });
  assert.equal(r.ok, true);
  assert.equal(r.minted, true);
  // A fresh starter grant must be shown before it is spent (§12.4).
  assert.equal(store.data.publik.cardShown, false);

  const v = viewOf(store);
  assert.ok(v.card, 'the card exists as soon as the install is connected');
  // Policy 0059: a plain anonymous mint is $0.00 — no lifetime starter until
  // this computer is linked to a publik account.
  assert.equal(v.card.balance, '$0.00 of publik API usage available');
  assert.equal(v.card.why, WHY);
  assert.deepEqual(v.card.primary, { label: 'Link this computer & pick a plan', url: CLAIM_URL });
  assert.deepEqual(v.card.secondary, { label: 'Later' });
  assert.deepEqual(Object.keys(v.card), ['title', 'balance', 'why', 'primary', 'secondary'], 'balance, then why, then the buttons');
  // The amount is the server's, not a constant: an install minted already
  // bound to a signed-in account carries the once-per-account starter instead.
  const other = fakeStore();
  await publik.provisionInstall({ build: build(), store: other, fetchImpl: fetchReturning(201, mintResponse({
    starter_micros: 50000, balance_micros: 50000, starting_credit_micros: 50000,
    wallet: { claim_state: 'claimed', balance_micros: 50000, starter: { remaining_micros: 50000 }, week: { used_micros: 0, budget_micros: null } }
  })) });
  assert.equal(viewOf(other).card.balance, '$0.05 of free starter usage');
  // No card before provisioning, and none for a build without a key.
  assert.equal(publik.ctaView({ connected: false }), null);
  assert.equal(publik.ctaView(null), null);
});

test('a claim_url off publikhq.com is dropped: the card has no button and publik:open hands nothing to the browser', async () => {
  const store = fakeStore();
  await publik.provisionInstall({ build: build(), store, fetchImpl: fetchReturning(201, mintResponse({ claim_url: 'https://evil.example/claim/HK7F-2QWD', wallet: null })) });
  const v = viewOf(store);
  assert.equal(v.claimUrl, '');
  assert.ok(v.card, 'the card still shows the balance and the justification');
  assert.equal(v.card.primary, null);
  assert.equal(v.settingsCta, null);

  // The main-process rule behind publik:open.
  assert.equal(publik.resolveOpenTarget('https://evil.example/x', ''), null);
  assert.equal(publik.resolveOpenTarget('javascript:alert(1)', ''), null);
  assert.equal(publik.resolveOpenTarget('https://publikhq.com.evil.example/claim', ''), null);
  assert.equal(publik.resolveOpenTarget('http://publikhq.com/claim/x', ''), null, 'https only');
  assert.equal(publik.resolveOpenTarget('https://evil.example/x', CLAIM_URL), CLAIM_URL, 'a hostile link falls back to the stored claim link, never to a third origin');
  assert.equal(publik.resolveOpenTarget('https://evil.example/x', 'https://evil.example/y'), null);
  assert.equal(publik.resolveOpenTarget(CLAIM_URL, ''), CLAIM_URL);
  assert.equal(publik.resolveOpenTarget('https://publikhq.com/dashboard/api', ''), 'https://publikhq.com/dashboard/api');

  // The low-starter banner drops a foreign top_up_url too.
  const low = publik.lowStarterNotice({ connected: true, claimState: 'anonymous', starterMicros: 50000, balanceMicros: 2000, topUpUrl: 'https://evil.example/top-up', claimUrl: '' });
  assert.ok(low);
  assert.equal(low.action, null);
});

test('"Later" marks the card seen and leaves the key, the provider and the balance in place', async () => {
  const store = fakeStore();
  await publik.provisionInstall({ build: build(), store, fetchImpl: fetchReturning(201, mintResponse()) });
  const before = JSON.parse(JSON.stringify(store.data));
  assert.equal(before.apiKeys.publik, KEY);

  publik.markCardSeen(store);

  const after = store.data;
  assert.equal(after.apiKeys.publik, KEY, 'the key stays');
  assert.equal(after.provider, 'publik', 'still on publik API — the balance is kept');
  assert.equal(after.publik.cardShown, true);
  assert.equal(after.publik.starterMicros, 0);
  assert.equal(after.publik.balanceMicros, 0);
  assert.equal(after.publik.claimUrl, CLAIM_URL, 'the settings button can still open the claim page later');
  for (const k of Object.keys(before.publik)) {
    if (k === 'cardShown') continue;
    assert.deepEqual(after.publik[k], before.publik[k], `publik.${k} changed`);
  }
  // A store that tampers with the key is refused.
  const bad = { getSettings: () => ({ apiKeys: { publik: KEY }, publik: {} }), setPublik() { this.getSettings = () => ({ apiKeys: { publik: '' }, publik: { cardShown: true } }); } };
  assert.throws(() => publik.markCardSeen(bad), /must not touch the key/);
});

test('the settings card button: anonymous → claim_url; claimed with no plan → "Pick a plan"; claimed with a plan → "Manage plan"', () => {
  const anon = publik.settingsCta({ connected: true, claimState: 'anonymous', claimUrl: CLAIM_URL, wallet: { claimState: 'anonymous' } });
  assert.deepEqual(anon, { label: 'Link this computer & pick a plan', url: CLAIM_URL });
  const noPlan = publik.settingsCta({ connected: true, claimState: 'claimed', claimUrl: '', wallet: { claimState: 'claimed', planId: 'none' } });
  assert.deepEqual(noPlan, { label: 'Pick a plan', url: 'https://publikhq.com/dashboard/api' });
  const plan = publik.settingsCta({ connected: true, claimState: 'claimed', claimUrl: '', wallet: { claimState: 'claimed', planId: 'basic', planLabel: 'Basic' } });
  assert.deepEqual(plan, { label: 'Manage plan', url: 'https://publikhq.com/dashboard/api' });
  assert.equal(publik.settingsCta({ connected: true, revoked: true, claimUrl: CLAIM_URL }), null);
  assert.equal(publik.settingsCta({ connected: false, claimUrl: CLAIM_URL }), null);
});

test('below 20% of the starter: one banner, the amounts from the wallet, exactly one link (top_up_url)', () => {
  const base = { connected: true, claimState: 'anonymous', starterMicros: 250000, claimUrl: CLAIM_URL, topUpUrl: CLAIM_URL };
  assert.equal(publik.lowStarterNotice({ ...base, balanceMicros: 250000, wallet: { claimState: 'anonymous', starterRemainingMicros: 250000 } }), null);
  assert.equal(publik.lowStarterNotice({ ...base, balanceMicros: 60000, wallet: { claimState: 'anonymous', starterRemainingMicros: 60000 } }), null, '24% is not low');
  assert.equal(publik.lowStarterNotice({ ...base, balanceMicros: 50000, wallet: { claimState: 'anonymous', starterRemainingMicros: 50000 } }), null, 'exactly 20% is not below');
  const low = publik.lowStarterNotice({ ...base, balanceMicros: 40000, wallet: { claimState: 'anonymous', starterRemainingMicros: 40000, topUpUrl: CLAIM_URL } });
  assert.ok(low);
  assert.match(low.message, /^\$0\.04 of your \$0\.25 free starter usage is left\. Link this computer and pick a plan to keep going, or use your own key in Settings\.$/);
  assert.deepEqual(low.action, { kind: 'link', label: 'Link this computer & pick a plan', url: CLAIM_URL });
  assert.equal((low.message.match(/https?:\/\//g) || []).length, 0, 'the message carries no URL of its own — the link is the button');
  // Falls back to the balance when the wallet has no starter figure; the x-publik-starter-remaining header feeds the wallet.
  assert.ok(publik.lowStarterNotice({ ...base, balanceMicros: 10000, wallet: null }));
  // A claimed install is never nagged about the starter.
  assert.equal(publik.lowStarterNotice({ ...base, claimState: 'claimed', balanceMicros: 1000, wallet: { claimState: 'claimed', starterRemainingMicros: 1000 } }), null);
});

test('a 402 is the response\'s message plus exactly one link, top_up_url', () => {
  const body = {
    type: 'insufficient_credit', claim_state: 'anonymous',
    message: 'Not enough publik credit for this request. The model behind this app is billed per use by its provider; publik passes that on at half the list price and nothing is charged behind your back. Link this computer and pick a plan at the link below, or use your own key.',
    top_up_url: CLAIM_URL, claim_url: CLAIM_URL, plans_url: 'https://publikhq.com/developers#plans', add_credit_url: 'https://publikhq.com/dashboard/api/add'
  };
  const r = publik.describeGatewayError({ status: 402, body });
  assert.equal(r.message, body.message);
  assert.equal(r.action.kind, 'link');
  assert.equal(r.action.url, CLAIM_URL);
  assert.equal(Object.keys(r).filter((k) => k === 'action').length, 1, 'one action, never a second link');
});

test('copy rule: the CTA copy says "publik API", dollars, never "credits", never the provider, never "OpenAI API access"', () => {
  assert.equal(publik.COPY.whyItCosts, WHY);
  const strings = [publik.COPY.whyItCosts, publik.COPY.whyItCostsToggle, ...Object.values(publik.COPY.cta), publik.starterLine({ starterMicros: 50000 })];
  const low = publik.lowStarterNotice({ connected: true, claimState: 'anonymous', starterMicros: 50000, balanceMicros: 1000, topUpUrl: CLAIM_URL });
  strings.push(low.message, low.action.label);
  for (const s of strings) {
    assert.doesNotMatch(s, /OpenAI API access/i, s);
    assert.doesNotMatch(s, /\bcredits\b/i, s);
    assert.doesNotMatch(s, /OpenAI|ChatGPT|Anthropic|Gemini|GPT/i, s);
    assert.doesNotMatch(s, /\btokens?\b/i, s);
    assert.doesNotMatch(s, /\bper[- ]token\b/i, s);
  }
  // The renderer and the settings card carry the same labels and the one sentence's toggle.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  // One primary button on the card; its label comes from renderer/publik-card.js.
  assert.match(html, /id="publik-primary"/);
  assert.match(html, /id="publik-why-summary"[^>]*>Why it costs money</);
  assert.match(html, /id="publik-why-text"/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(js, /cue\.publikCardSeen\(\)/);
  assert.match(js, /function showPublikCard\(\)/);
  assert.match(js, /action\.kind === 'card'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /publikCardSeen: \(\) => ipcRenderer\.invoke\('publik:card-seen'\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('publik:card-seen'/);
  assert.match(main, /publik\.resolveOpenTarget\(url, s\.publik\.claimUrl\)/);
  assert.match(main, /!settings\.publik\.cardShown/, 'runFeature gates the starter on the card having been shown');
});
