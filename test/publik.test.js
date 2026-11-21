const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// src/publik-ui.js: the words, the wallet shapes and the card views. The
// network (sign-in gate, key, GET /wallet) is src/publik.js, tested in
// publik-module.test.js.
const publik = require('../src/publik-ui');

// ---- helpers -----------------------------------------------------------------

test('isSafePublikLink only accepts the publikhq.com origin', () => {
  assert.equal(publik.isSafePublikLink('https://publikhq.com/claim/HK7F-2QWD'), true);
  assert.equal(publik.isSafePublikLink('https://publikhq.com.evil/claim/x'), false);
  assert.equal(publik.isSafePublikLink('http://publikhq.com/claim/x'), false);
  assert.equal(publik.isSafePublikLink('javascript:alert(1)'), false);
  assert.equal(publik.isSafePublikLink(null), false);
});

test('formatMicros renders dollars', () => {
  assert.equal(publik.formatMicros(1920000), '$1.92');
  assert.equal(publik.formatMicros(400), '$0.0004');
  assert.equal(publik.formatMicros(0), '$0.00');
  assert.equal(publik.formatMicros('nope'), '');
});

test('osName maps Node platforms to the contract\'s os values', () => {
  assert.equal(publik.osName('darwin'), 'macos');
  assert.equal(publik.osName('win32'), 'windows');
  assert.equal(publik.osName('linux'), 'linux');
});

test('pickModels maps the three-tier response onto cue\'s two tiers and falls back to the defaults', () => {
  assert.deepEqual(publik.pickModels({ fast: 'publik-fast', balanced: 'publik-balanced', smart: 'publik-smart' }), { fast: 'publik-fast', smart: 'publik-balanced' });
  assert.deepEqual(publik.pickModels(undefined), publik.DEFAULT_MODELS);
  assert.deepEqual(publik.DEFAULT_MODELS, { fast: 'publik-fast', smart: 'publik-balanced' });
});

// ---- wallet ------------------------------------------------------------------

test('normalizeWallet reads the /wallet body and derives top_up_url by claim state', () => {
  const w = publik.normalizeWallet({
    claim_state: 'anonymous', balance_micros: 181240,
    starter: { remaining_micros: 181240, expires_at: '2026-10-18T17:04:11Z' },
    plan: { id: 'none', label: 'No plan', monthly_micros: 0 },
    week: { used_micros: 68760, budget_micros: null, resets_at: '2026-09-25T17:04:11Z', window_days: 7 },
    daily_cap_micros: 250000, spent_today_micros: 68760,
    claim_url: 'https://publikhq.com/claim/HK7F-2QWD', add_credit_url: 'https://publikhq.com/dashboard/api/add'
  });
  assert.equal(w.balanceMicros, 181240);
  assert.equal(w.claimState, 'anonymous');
  assert.equal(w.starterRemainingMicros, 181240);
  assert.equal(w.weekBudgetMicros, null);
  assert.equal(w.weekUsedMicros, 68760);
  assert.equal(w.topUpUrl, 'https://publikhq.com/claim/HK7F-2QWD');

  const claimed = publik.normalizeWallet({ claim_state: 'claimed', balance_micros: 3120000, claim_url: null, add_credit_url: 'https://publikhq.com/dashboard/api/add', week: { used_micros: 1200000, budget_micros: 4620000, resets_at: '2026-09-25T17:04:11Z' } });
  assert.equal(claimed.topUpUrl, 'https://publikhq.com/dashboard/api/add');
  assert.equal(claimed.weekBudgetMicros, 4620000);
  // The module's wallet shape (src/publik.js readWallet: plan.kind, account) reads the same way.
  const fromModule = publik.normalizeWallet({ claim_state: 'claimed', account: { handle: 'mann' }, plan: { kind: 'plan', label: 'Plus' }, balance_micros: 0, claim_url: null, top_up_url: 'https://publikhq.com/wallet?top_up=1' });
  assert.equal(fromModule.claimState, 'claimed');
  assert.equal(fromModule.planLabel, 'Plus');
  assert.equal(fromModule.topUpUrl, 'https://publikhq.com/wallet?top_up=1');
  // A hostile link is dropped.
  assert.equal(publik.normalizeWallet({ claim_state: 'anonymous', claim_url: 'https://evil.example/claim' }).claimUrl, null);
});

// ---- headers -----------------------------------------------------------------

test('readGatewayHeaders reads the x-publik-* set from a Headers object or a plain object', () => {
  const h = new Map(Object.entries({
    'x-publik-request-id': 'req_1', 'x-publik-model': 'gpt-5.6-luna', 'x-publik-balance': '181240',
    'x-publik-week-used': '68760', 'x-publik-week-budget': 'none', 'x-publik-week-resets-at': '2026-09-25T17:04:11Z',
    'x-publik-claim-state': 'anonymous', 'x-publik-starter-remaining': '181240', 'x-publik-reserved-micros': '41000'
  }));
  const r = publik.readGatewayHeaders({ get: (k) => (h.has(k) ? h.get(k) : null) });
  assert.equal(r.balanceMicros, 181240);
  assert.equal(r.weekBudgetMicros, null);
  assert.equal(r.weekUsedMicros, 68760);
  assert.equal(r.claimState, 'anonymous');
  assert.equal(r.starterRemainingMicros, 181240);
  assert.equal(r.reservedMicros, 41000);
  assert.equal(r.chargeMicros, null);
  assert.equal(r.model, 'gpt-5.6-luna');

  const plain = publik.readGatewayHeaders({ 'x-publik-balance': '5', 'x-publik-week-budget': '4620000', 'x-publik-claim-state': 'claimed' });
  assert.equal(plain.balanceMicros, 5);
  assert.equal(plain.weekBudgetMicros, 4620000);
  assert.equal(plain.claimState, 'claimed');

  assert.equal(publik.readGatewayHeaders({ get: () => null }), null);
  assert.equal(publik.readGatewayHeaders(null), null);
});

// ---- error mapping -----------------------------------------------------------

test('402 insufficient_credit renders the message plus exactly one link: top_up_url', () => {
  const anon = publik.describeGatewayError({ status: 402, body: {
    type: 'insufficient_credit', message: 'Not enough publik credit for this request.', available_micros: 1240, required_micros: 41000,
    claim_state: 'anonymous', top_up_url: 'https://publikhq.com/claim/HK7F-2QWD',
    claim_url: 'https://publikhq.com/claim/HK7F-2QWD', add_credit_url: 'https://publikhq.com/dashboard/api/add', plans_url: 'https://publikhq.com/developers#plans'
  } });
  // The response's own message is rendered as-is (CONTRACT §12.3): it carries the justification.
  assert.equal(anon.message, 'Not enough publik credit for this request.');
  assert.equal(anon.fromResponse, true);
  assert.deepEqual(anon.action, { kind: 'link', label: 'Link this computer & pick a plan', url: 'https://publikhq.com/claim/HK7F-2QWD' });
  assert.equal((anon.message.match(/https?:\/\//g) || []).length, 0, 'the message carries no URL of its own');

  const claimed = publik.describeGatewayError({ status: 402, body: {
    type: 'insufficient_credit', available_micros: 0, claim_state: 'claimed',
    top_up_url: 'https://publikhq.com/dashboard/api/add', claim_url: null, add_credit_url: 'https://publikhq.com/dashboard/api/add'
  } });
  // No message in the body → a local sentence that says what the link does, still one link.
  assert.match(claimed.message, /^publik API balance is used up \(\$0\.00 left\)\. Add a plan or a pack at the link below, or use your own key in Settings\.$/);
  assert.equal(claimed.fromResponse, false);
  assert.deepEqual(claimed.action, { kind: 'link', label: 'Add a plan or pack', url: 'https://publikhq.com/dashboard/api/add' });
  // Anonymous with no message (policy 0059): the install holds $0.00; linking pays $0.05 once. No promise of a starter already on the computer.
  const anonLocal = publik.describeGatewayError({ status: 402, body: { type: 'insufficient_credit', available_micros: 0, claim_state: 'anonymous', top_up_url: 'https://publikhq.com/claim/HK7F-2QWD' } });
  assert.equal(anonLocal.message, 'publik API: your balance is too low for this request. Link this computer to your publik account at the link below for $0.05 of free use, pick a plan there, or use your own key in Settings.');
  assert.equal(anonLocal.fromResponse, false);
  assert.deepEqual(anonLocal.action, { kind: 'link', label: 'Link this computer & pick a plan', url: 'https://publikhq.com/claim/HK7F-2QWD' });

  // A top_up_url on a foreign origin is dropped: the message still renders, with no link.
  const hostile = publik.describeGatewayError({ status: 402, body: { type: 'insufficient_credit', top_up_url: 'https://evil.example/x' } });
  assert.equal(hostile.action, null);
});

test('402 model_requires_claim links to the claim page', () => {
  const r = publik.describeGatewayError({ status: 402, body: { type: 'model_requires_claim', top_up_url: 'https://publikhq.com/claim/HK7F-2QWD' } });
  assert.match(r.message, /publik-smart needs a linked publik account/);
  assert.equal(r.action.kind, 'link');
  assert.equal(r.action.url, 'https://publikhq.com/claim/HK7F-2QWD');
});

test('401 key_revoked: reprovision:true re-mints silently, false offers Reconnect', () => {
  const idle = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: true } });
  assert.deepEqual(idle.action, { kind: 'reprovision' });
  const removed = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: false } });
  assert.match(removed.message, /^publik API is disconnected\./);
  assert.equal(removed.action.kind, 'reconnect');
  const invalid = publik.describeGatewayError({ status: 401, body: { type: 'invalid_api_key' } });
  assert.equal(invalid.action.kind, 'reconnect');
});

test('429 types and Retry-After', () => {
  const cap = publik.describeGatewayError({ status: 429, body: { type: 'daily_cap_reached', claim_state: 'anonymous', claim_url: 'https://publikhq.com/claim/X' }, retryAfter: 3600 });
  assert.match(cap.message, /daily publik API spending cap — it resets in 60 minutes/);
  assert.equal(cap.action.url, 'https://publikhq.com/claim/X');
  const week = publik.describeGatewayError({ status: 429, body: { type: 'week_budget_reached', add_credit_url: 'https://publikhq.com/dashboard/api/add' }, retryAfter: 86400 });
  assert.match(week.message, /this week is used up — it resets in 24 hours/);
  assert.equal(week.action.label, 'Add credit');
  const busy = publik.describeGatewayError({ status: 429, body: { type: 'rate_limit_exceeded' }, retryAfter: 12 });
  assert.match(busy.message, /busy right now\. Wait 12 seconds/);
  assert.equal(busy.action, null);
});

test('400 unknown_model, 413, 503 and network failures; anything else falls through', () => {
  assert.match(publik.describeGatewayError({ status: 400, body: { type: 'unknown_model' }, model: 'gpt-9' }).message, /does not serve "gpt-9".*publik-fast, publik-balanced, publik-smart/);
  assert.match(publik.describeGatewayError({ status: 404, body: {}, model: 'x' }).message, /does not serve "x"/);
  assert.match(publik.describeGatewayError({ status: 413, body: {} }).message, /too large/);
  assert.match(publik.describeGatewayError({ status: 503, body: { type: 'gateway_unavailable' } }).message, /unreachable right now\. Nothing is being charged/);
  assert.match(publik.describeGatewayError({ status: undefined, body: null }).message, /unreachable/);
  assert.equal(publik.describeGatewayError({ status: 400, body: { type: 'invalid_request' } }), null);
  assert.equal(publik.describeGatewayError({ status: 500, body: {} }), null);
});

// ---- status line -------------------------------------------------------------

test('statusLine shows the gateway\'s last answer over the fixed revoked/disconnected copy', () => {
  const base = { connected: true, revoked: false, disconnected: false, keyId: 'k'.repeat(12), disclosureAccepted: 1, lastError: '', line: 'Ready · $0.18 left' };
  assert.deepEqual(publik.statusLine(base), { text: `Connected · key ${'k'.repeat(12)} · Ready · $0.18 left`, warn: false });
  // After a dashboard revoke the stale key is still on disk (connected) and
  // revoked is set; a failed Reconnect must show why, not the generic line.
  const masked = { ...base, revoked: true, lastError: 'This install was disconnected by its owner. Provision a new install.' };
  assert.deepEqual(publik.statusLine(masked), { text: 'This install was disconnected by its owner. Provision a new install.', warn: true });
  assert.deepEqual(publik.statusLine({ ...base, revoked: true }), { text: 'publik API key was revoked. Reconnect to set this computer up again.', warn: true });
  // Key already cleared (Disconnect pressed first), then the dashboard revoke.
  assert.deepEqual(publik.statusLine({ ...base, connected: false, disconnected: true, lastError: 'Too many installs from this network.' }), { text: 'Too many installs from this network.', warn: true });
  assert.deepEqual(publik.statusLine({ ...base, connected: false, disconnected: true }), { text: 'publik API is disconnected. This computer was removed from your publik account.', warn: true });
  assert.deepEqual(publik.statusLine({ ...base, connected: false, disclosureAccepted: 0, lastError: 'ignored before consent' }), { text: 'Not set up yet — no key needed to set it up.', warn: false });
  assert.deepEqual(publik.statusLine({ ...base, connected: false, lastError: 'Unknown app token.' }), { text: 'Unknown app token.', warn: true });
  assert.deepEqual(publik.statusLine({ ...base, connected: false }), { text: 'Connecting…', warn: false });
  assert.deepEqual(publik.statusLine(null), { text: '', warn: false });
});

test('the settings card paints publik:state.status and keeps no status copy of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function renderPublikBlock()');
  assert.ok(start > -1, 'renderPublikBlock not found');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  // renderPublikBlock paints the card view; the card view takes the revoked
  // and disconnected sentences from publik:state.status (statusLine).
  assert.match(body, /cardView\(p, settings\.provider\)/);
  assert.match(body, /view\.status/);
  const card = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'publik-card.js'), 'utf8');
  assert.match(card, /p\.status/);
  for (const text of [body, card]) {
    assert.doesNotMatch(text, /key was revoked/, 'the revoked copy lives in src/publik.js statusLine()');
    assert.doesNotMatch(text, /is disconnected\./, 'the disconnected copy lives in src/publik.js statusLine()');
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /view\.status = publik\.statusLine\(view\)/);
});

test('isInstallFinished: 403 install_revoked and 410 end an install_id; a 401 key_revoked does not', () => {
  assert.equal(publik.isInstallFinished({ status: 403, type: 'install_revoked', reprovision: false }), true);
  assert.equal(publik.isInstallFinished({ status: 410, type: '' }), true);
  assert.equal(publik.isInstallFinished({ status: 401, type: 'key_revoked', reprovision: false }), false);
  assert.equal(publik.isInstallFinished({ status: 403, type: 'app_suspended' }), false);
  assert.equal(publik.isInstallFinished({ status: 429, type: 'rate_limited' }), false);
  assert.equal(publik.isInstallFinished(null), false);
});

// ---- balance line ------------------------------------------------------------

test('balanceLine renders the anonymous, claimed-with-plan and claimed-no-plan forms', () => {
  assert.equal(publik.balanceLine({ connected: false }), '');
  assert.equal(publik.balanceLine({ connected: true, claimState: 'anonymous', balanceMicros: 30000, starterMicros: 50000, wallet: { claimState: 'anonymous' } }), 'Ready · $0.03 left of $0.05 free starter usage');
  assert.equal(publik.balanceLine({ connected: true, balanceMicros: 180000, starterMicros: 0, wallet: { claimState: 'anonymous' } }), 'Ready · $0.18 left');
  const now = Date.parse('2026-09-22T12:00:00Z');
  const plan = publik.balanceLine({ connected: true, balanceMicros: 3120000, wallet: { claimState: 'claimed', weekUsedMicros: 1200000, weekBudgetMicros: 4620000, weekResetsAt: '2026-09-25T17:04:11Z' } }, now);
  assert.match(plan, /^Linked to your publik account · \$3\.12 left · This week \$1\.20 of \$4\.62 · Resets \w{3} \d\d:\d\d$/);
  assert.equal(publik.balanceLine({ connected: true, balanceMicros: 3120000, wallet: { claimState: 'claimed', weekUsedMicros: 680000, weekBudgetMicros: null } }), 'Linked to your publik account · $3.12 left · $0.68 used this week');
});
