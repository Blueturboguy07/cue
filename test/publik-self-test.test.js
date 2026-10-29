// selfTest(): the one line the built app prints under PUBLIK_SELF_TEST=1,
// driven with a stub fetch and an in-memory settings store.
const assert = require('node:assert/strict');
const test = require('node:test');

const publik = require('../src/publik');

const BUILD = { appToken: 'pat_cue_' + 'c'.repeat(32), appSlug: 'cue', baseUrl: 'https://gw.test/api/v1', disclosureVersion: 1, available: true };
const KEY = 'pk_live_' + 'a'.repeat(12) + '_' + 's'.repeat(32);
const DEVICE = { appVersion: '0.2.5', platform: 'darwin', osVersion: '25.6.0', arch: 'arm64', deviceName: 'mac' };

function fakeStore(initial = {}) {
  const data = {
    provider: 'openai',
    apiKeys: { openai: '', publik: '' },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
    publik: { installId: '', keyId: '', revoked: false, lastError: '' },
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

function stubFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 300, status, headers: { get: () => null }, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('a fresh install provisions, stores the key and prints ok with slug, version and install', async () => {
  const store = fakeStore();
  const { fetchImpl, calls } = stubFetch(201, { key: KEY, key_id: 'k1', claim_state: 'anonymous' });
  const line = await publik.selfTest({ build: BUILD, store, device: DEVICE, fetchImpl });
  const installId = store.data.publik.installId;
  assert.equal(line, `publik self-test: ok cue 0.2.5 (install ${installId.slice(0, 8)})`);
  assert.equal(store.data.apiKeys.publik, KEY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.app_version, '0.2.5');
  assert.ok(!line.includes('pk_'));
});

test('an install that already has a key replays its install_id and keeps the key', async () => {
  const store = fakeStore({ apiKeys: { openai: '', publik: KEY }, publik: { installId: 'abcdef12-0000', revoked: false } });
  const { fetchImpl, calls } = stubFetch(200, { key: null, claim_state: 'claimed' });
  const line = await publik.selfTest({ build: BUILD, store, device: DEVICE, fetchImpl });
  assert.equal(line, 'publik self-test: ok cue 0.2.5 (install abcdef12)');
  assert.equal(calls[0].body.install_id, 'abcdef12-0000');
  assert.equal(store.data.apiKeys.publik, KEY);
});

test('a build without an app token prints failed without calling the gateway', async () => {
  const { fetchImpl, calls } = stubFetch(201, {});
  const line = await publik.selfTest({ build: { ...BUILD, appToken: '', available: false }, store: fakeStore(), device: DEVICE, fetchImpl });
  assert.equal(line, 'publik self-test: failed: This build has no publik app token.');
  assert.equal(calls.length, 0);
});

test('a gateway error prints its message', async () => {
  const { fetchImpl } = stubFetch(403, { error: { type: 'not_owner', message: 'This app token is not valid.' } });
  const line = await publik.selfTest({ build: BUILD, store: fakeStore(), device: DEVICE, fetchImpl });
  assert.equal(line, 'publik self-test: failed: This app token is not valid.');
});
