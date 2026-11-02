// Provisioning end to end against a local fake gateway: the real provision()
// and fetchWallet() over Node's global fetch, driven by the same
// provisionInstall() flow main.js runs, with an in-memory settings store.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const publik = require('../src/publik');

const TOKEN = 'pat_cue_' + 'c'.repeat(32);
const KEY_SECRET = 's'.repeat(32);

function fakeStore(initial = {}) {
  const data = {
    provider: 'openai',
    apiKeys: { openai: '', publik: '' },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
    publik: { installId: '', keyId: '', baseUrl: '', claimUrl: '', claimCode: '', claimState: '', starterMicros: 0, balanceMicros: null, balanceAt: 0, wallet: null, disclosureAccepted: 0, defaultApplied: false, revoked: false, disconnected: false, lastError: '' },
    ...initial
  };
  return {
    data,
    getSettings: () => data,
    setSettings(patch) { if (patch.models) data.models = { ...data.models, ...patch.models }; return data; },
    setPublik(patch) {
      const { apiKey, ...rest } = patch;
      if (typeof apiKey === 'string') data.apiKeys.publik = apiKey;
      data.publik = { ...data.publik, ...rest };
      return data;
    }
  };
}

// The fake gateway: mints once per install_id, replays after that, serves
// /wallet for a live key, answers 401 key_revoked for a revoked one. An
// install revoked from the dashboard (`ownerRevoked`) is finished: POST
// /installs answers 403 install_revoked with reprovision:false, the way
// publik's installs route does for revoke_reason dashboard|abuse.
function startFakeGateway() {
  const installs = new Map(); // install_id -> { keyId, key, revoked, ownerRevoked }
  const requests = [];
  const gw = { refuseAll: false }; // every POST /installs answers 403 install_revoked
  let mintCounter = 0;
  const claimCodeFor = (n) => (n === 1 ? 'HK7F-2QWD' : `HK7F-2QW${n}`);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/api/v1/installs') {
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (bearer !== TOKEN && body.app_token !== TOKEN) return send(401, { error: { type: 'invalid_app_token', message: 'Unknown app token.' } });
        if (body.app_slug !== 'cue' || !body.install_id || !(body.disclosure_version >= 1)) return send(400, { error: { type: 'invalid_field', message: 'bad field', field: 'app_slug' } });
        const existing = installs.get(body.install_id);
        if (gw.refuseAll || (existing && existing.ownerRevoked)) {
          return send(403, { error: { type: 'install_revoked', message: 'This install was disconnected by its owner. Provision a new install.', reprovision: false } });
        }
        if (existing && !existing.revoked) {
          return send(200, { install_id: body.install_id, key: null, key_id: existing.keyId, starter_micros: 0, claim_state: 'anonymous', base_url: `http://127.0.0.1:${server.address().port}/api/v1` });
        }
        mintCounter += 1;
        const keyId = String(mintCounter).padStart(12, '0').replace(/\d/g, (d) => 'abcdefghijkl'[Number(d)]);
        const key = `pk_test_${keyId}_${KEY_SECRET}`;
        const claimCode = claimCodeFor(mintCounter);
        installs.set(body.install_id, { keyId, key, revoked: false, ownerRevoked: false });
        return send(201, {
          install_id: body.install_id, key, key_id: keyId,
          base_url: `http://127.0.0.1:${server.address().port}/api/v1`,
          models: { fast: 'publik-fast', balanced: 'publik-balanced', smart: 'publik-smart' },
          claim_code: claimCode, claim_url: `https://publikhq.com/claim/${claimCode}`,
          // Policy 0059: an install is minted at $0.00. None of these fixtures
          // mint an install already bound to a signed-in account, so starter
          // stays 0 whether or not the install_id was seen before.
          starter_micros: 0, balance_micros: 0, starting_credit_micros: 0,
          wallet: { claim_state: 'anonymous', balance_micros: 0, starter: { remaining_micros: 0 }, week: { used_micros: 0, budget_micros: null, resets_at: '2026-09-25T17:04:11Z' }, claim_url: `https://publikhq.com/claim/${claimCode}` }
        });
      }
      if (req.method === 'GET' && req.url === '/api/v1/wallet') {
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        const row = [...installs.values()].find((r) => r.key === bearer);
        if (!row) return send(401, { error: { type: 'invalid_api_key', message: 'Invalid API key.' } });
        if (row.ownerRevoked) return send(401, { error: { type: 'key_revoked', message: 'This key was revoked.', reprovision: false } });
        if (row.revoked) return send(401, { error: { type: 'key_revoked', message: 'This key was revoked.', reprovision: true } });
        return send(200, { claim_state: 'anonymous', balance_micros: 209000, starter: { remaining_micros: 209000 }, week: { used_micros: 41000, budget_micros: null, resets_at: '2026-09-25T17:04:11Z' }, daily_cap_micros: 250000, spent_today_micros: 41000, claim_url: 'https://publikhq.com/claim/HK7F-2QWD' });
      }
      send(404, { error: { type: 'not_found', message: 'no route' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(Object.assign(gw, {
      server, installs, requests,
      baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
      close: () => new Promise((r) => server.close(r))
    })));
  });
}

// What main.js publikState() hands the renderer for the status sentence.
function statusOf(store) {
  const s = store.getSettings();
  const p = s.publik;
  return publik.statusLine({ connected: !!s.apiKeys.publik, revoked: !!p.revoked, disconnected: !!p.disconnected, keyId: p.keyId, disclosureAccepted: p.disclosureAccepted, lastError: p.lastError, line: '' });
}

test('provisionInstall mints once, stores only apiKeys.publik + publik.*, then GET /wallet works with that key', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: TOKEN, appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    const store = fakeStore({ provider: 'openai', apiKeys: { openai: 'sk-user-typed-this', publik: '' } });
    const events = [];
    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: process.platform, osVersion: '1', arch: process.arch, deviceName: 'CI box' }, log: (e) => events.push(e) });

    assert.equal(r.ok, true);
    assert.equal(r.minted, true);
    assert.match(store.data.apiKeys.publik, publik.KEY_RE);
    assert.equal(store.data.publik.keyId, r.keyId);
    assert.equal(store.data.publik.baseUrl, gw.baseUrl);
    assert.equal(store.data.publik.claimUrl, 'https://publikhq.com/claim/HK7F-2QWD');
    assert.equal(store.data.publik.starterMicros, 0);
    assert.equal(store.data.publik.balanceMicros, 0);
    assert.equal(store.data.publik.revoked, false);
    assert.deepEqual(store.data.models.publik, { fast: 'publik-fast', smart: 'publik-balanced' });
    // Never touched: the user's own key and the selected provider.
    assert.equal(store.data.apiKeys.openai, 'sk-user-typed-this');
    assert.equal(store.data.provider, 'openai');
    assert.equal(events[0].event, 'publik_provisioned');

    const mint = gw.requests[0];
    assert.equal(mint.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(mint.body.app_token, TOKEN);
    assert.equal(mint.body.install_id, store.data.publik.installId);
    assert.equal(mint.body.device_name, 'CI box');

    // Second call: a live key means no second mint, no network call at all.
    const again = await publik.provisionInstall({ build, store });
    assert.deepEqual(again, { ok: true, minted: false });
    assert.equal(gw.requests.length, 1);

    const wallet = await publik.fetchWallet({ baseUrl: store.data.publik.baseUrl, apiKey: store.data.apiKeys.publik });
    assert.equal(wallet.balanceMicros, 209000);
    assert.equal(wallet.weekUsedMicros, 41000);
    assert.equal(wallet.topUpUrl, 'https://publikhq.com/claim/HK7F-2QWD');
  } finally { await gw.close(); }
});

test('a 200 replay with no credential on disk mints a fresh install_id exactly once', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: TOKEN, appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    // Simulate the crash-between-mint-and-write case: the server knows this
    // install_id, the file does not have the key.
    const orphanId = publik.newInstallId();
    await publik.provision({ build, installId: orphanId, appVersion: '0.2.3', platform: 'linux', arch: 'x64' });
    const store = fakeStore();
    store.data.publik.installId = orphanId;

    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: 'linux', arch: 'x64' } });
    assert.equal(r.ok, true);
    assert.notEqual(store.data.publik.installId, orphanId);
    assert.match(store.data.apiKeys.publik, publik.KEY_RE);
    const bodies = gw.requests.filter((q) => q.url === '/api/v1/installs').map((q) => q.body.install_id);
    assert.deepEqual(bodies, [orphanId, orphanId, store.data.publik.installId]);
  } finally { await gw.close(); }
});

test('a revoked key (401 key_revoked, reprovision:true) re-provisions with the same install_id', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: TOKEN, appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    const store = fakeStore();
    await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: 'linux', arch: 'x64' } });
    const firstKey = store.data.apiKeys.publik;
    const installId = store.data.publik.installId;
    gw.installs.get(installId).revoked = true;

    await assert.rejects(publik.fetchWallet({ baseUrl: gw.baseUrl, apiKey: firstKey }), (e) => e.status === 401 && e.type === 'key_revoked' && e.reprovision === true);
    store.setPublik({ revoked: true });
    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: 'linux', arch: 'x64' } });
    assert.equal(r.ok, true);
    assert.equal(store.data.publik.installId, installId);
    assert.notEqual(store.data.apiKeys.publik, firstKey);
    assert.equal(store.data.publik.revoked, false);
    assert.equal(store.data.publik.starterMicros, 0, 'a re-mint gets no second starter');
  } finally { await gw.close(); }
});

// Bug reports 0a3e7542 / 3c6adc78 / 9d5ca184: the owner revoked the computer
// from the publik dashboard (revoke_reason 'dashboard'), then pressed
// Reconnect. The gateway answers 403 install_revoked reprovision:false for
// that install_id for ever; v0.2.5 re-sent the same install_id on every press
// and the settings card hid the answer behind the fixed "key was revoked" copy.
test('a dashboard-revoked install (403 install_revoked) mints a fresh install_id once and stores the new key and claim link', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: TOKEN, appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    const store = fakeStore({ publik: { installId: '', keyId: '', baseUrl: '', claimUrl: '', claimCode: '', claimState: '', starterMicros: 0, balanceMicros: null, balanceAt: 0, wallet: null, disclosureAccepted: 1, defaultApplied: true, revoked: false, disconnected: false, lastError: '' } });
    const events = [];
    await publik.provisionInstall({ build, store, device: { appVersion: '0.2.5', platform: 'win32', arch: 'x64', deviceName: 'HusainLaptop' } });
    const firstKey = store.data.apiKeys.publik;
    const firstKeyId = store.data.publik.keyId;
    const oldId = store.data.publik.installId;
    assert.equal(store.data.publik.claimUrl, 'https://publikhq.com/claim/HK7F-2QWD');

    // Revoked from the dashboard: the next metered call is 401 key_revoked
    // reprovision:false and main.js publikHandleRevoked() stores this.
    gw.installs.get(oldId).ownerRevoked = true;
    await assert.rejects(publik.fetchWallet({ baseUrl: gw.baseUrl, apiKey: firstKey }), (e) => e.status === 401 && e.type === 'key_revoked' && e.reprovision === false);
    store.setPublik({ revoked: true, disconnected: true, lastError: '' });
    assert.match(statusOf(store).text, /^publik API key was revoked\. Reconnect/);

    // Reconnect (main.js publik:reconnect): revoked:true, then provisionInstall.
    store.setPublik({ revoked: true });
    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.5', platform: 'win32', arch: 'x64', deviceName: 'HusainLaptop' }, log: (e) => events.push(e) });
    assert.equal(r.ok, true);
    assert.equal(r.minted, true);
    assert.notEqual(store.data.publik.installId, oldId, 'a finished install_id is never re-sent');
    assert.match(store.data.apiKeys.publik, publik.KEY_RE);
    assert.notEqual(store.data.apiKeys.publik, firstKey);
    assert.notEqual(store.data.publik.keyId, firstKeyId);
    assert.equal(store.data.publik.claimUrl, 'https://publikhq.com/claim/HK7F-2QW2', 'the new install has its own claim link');
    assert.equal(store.data.publik.revoked, false);
    assert.equal(store.data.publik.disconnected, false);
    assert.equal(store.data.publik.lastError, '');
    assert.equal(store.data.publik.starterMicros, 0, 'a fresh install gets no starter');
    assert.match(statusOf(store).text, new RegExp(`^Connected · key ${store.data.publik.keyId}`));
    const bodies = gw.requests.filter((q) => q.url === '/api/v1/installs').map((q) => q.body.install_id);
    assert.deepEqual(bodies, [oldId, oldId, store.data.publik.installId]);
    assert.deepEqual(events.map((e) => e.event), ['publik_install_reprovisioned', 'publik_provisioned']);
    assert.equal(events[0].msg, oldId);
    assert.equal(events[0].context.type, 'install_revoked');
  } finally { await gw.close(); }
});

test('a second 403 install_revoked on the fresh install_id stops after one retry, drops the stale key and keeps the gateway message', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: TOKEN, appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    const store = fakeStore({ apiKeys: { openai: '', publik: 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32) } });
    const oldId = publik.newInstallId();
    store.setPublik({ installId: oldId, keyId: 'a'.repeat(12), claimUrl: 'https://publikhq.com/claim/OLD1-CODE', disclosureAccepted: 1, revoked: true, disconnected: true });
    gw.refuseAll = true;
    const events = [];
    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.5', platform: 'win32', arch: 'x64' }, log: (e) => events.push(e) });
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 403);
    assert.equal(r.error.type, 'install_revoked');
    const posts = gw.requests.filter((q) => q.url === '/api/v1/installs');
    assert.equal(posts.length, 2, 'one retry with a fresh install_id, then stop');
    assert.equal(posts[0].body.install_id, oldId);
    assert.notEqual(posts[1].body.install_id, oldId);
    assert.equal(store.data.publik.installId, posts[1].body.install_id, 'the fresh install_id is kept for the next press');
    assert.equal(store.data.apiKeys.publik, '', 'the stale key is gone');
    assert.equal(store.data.publik.claimUrl, '', 'the old claim link is gone');
    assert.match(store.data.publik.lastError, /disconnected by its owner/);
    // The settings card shows the gateway's answer, not the fixed copy.
    const status = statusOf(store);
    assert.equal(status.warn, true);
    assert.match(status.text, /disconnected by its owner/);
    assert.deepEqual(events.map((e) => e.event), ['publik_install_reprovisioned', 'publik_provision_failed']);
    assert.equal(events[1].context.freshInstall, true);
  } finally { await gw.close(); }
});

test('a rejected mint records lastError and leaves the store without a key', async () => {
  const gw = await startFakeGateway();
  try {
    const build = { appToken: 'pat_cue_' + 'z'.repeat(32), appSlug: 'cue', baseUrl: gw.baseUrl, disclosureVersion: 1, available: true };
    const store = fakeStore();
    const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: 'linux', arch: 'x64' } });
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 401);
    assert.equal(store.data.apiKeys.publik, '');
    assert.match(store.data.publik.lastError, /Unknown app token/);
    assert.ok(store.data.publik.installId, 'the install id is kept so the retry is idempotent');
  } finally { await gw.close(); }
});

test('an unreachable gateway fails closed with no key and no crash', async () => {
  const gw = await startFakeGateway();
  const { baseUrl } = gw;
  await gw.close();
  const build = { appToken: TOKEN, appSlug: 'cue', baseUrl, disclosureVersion: 1, available: true };
  const store = fakeStore();
  const r = await publik.provisionInstall({ build, store, device: { appVersion: '0.2.3', platform: 'linux', arch: 'x64' } });
  assert.equal(r.ok, false);
  assert.equal(store.data.apiKeys.publik, '');
  assert.ok(store.data.publik.lastError);
});
