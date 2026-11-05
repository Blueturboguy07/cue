const assert = require('node:assert/strict');
const test = require('node:test');
const { provisionInstall, fetchWallet } = require('../src/publik');
const { deferred } = require('./helpers/main-harness');

const build = { available: true, baseUrl: 'https://synthetic.invalid/v1', appToken: 'synthetic', appSlug: 'cue', disclosureVersion: 1 };
function storeFixture() {
  const writes = [];
  return { writes, getSettings: () => ({ apiKeys: {}, publik: {} }), setPublik: (value) => writes.push(value), setSettings: (value) => writes.push(value) };
}

test('cancelled provisioning releases an unresponsive transport without mint retry or state writes', async () => {
  const request = new AbortController(), entered = deferred(), store = storeFixture(); let signal, calls = 0;
  const pending = provisionInstall({ build, store, signal: request.signal, fetchImpl: (_url, init) => {
    calls++; signal = init.signal; entered.resolve(); return new Promise(() => {});
  } });
  await entered.promise;
  request.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(store.writes.length, 0);
});

test('cancellation while reading provisioning JSON cannot persist a key or trigger replay', async () => {
  const request = new AbortController(), body = deferred(), entered = deferred(), store = storeFixture(); let calls = 0;
  const pending = provisionInstall({ build, store, signal: request.signal, fetchImpl: async () => {
    calls++;
    return { ok: true, json: () => { entered.resolve(); return body.promise; } };
  } });
  await entered.promise;
  request.abort();
  assert.equal((await pending).cancelled, true);
  body.resolve({ key: null });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(store.writes.length, 0);
});

test('an already cancelled wallet request never reaches fetch', async () => {
  const request = new AbortController(); request.abort(); let calls = 0;
  await assert.rejects(fetchWallet({ apiKey: 'synthetic', signal: request.signal, fetchImpl: async () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
