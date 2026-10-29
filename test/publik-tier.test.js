const test = require('node:test');
const assert = require('node:assert');
const publik = require('../src/publik');

test('tierSlug accepts fast/balanced/smart with or without the publik- prefix', () => {
  assert.strictEqual(publik.tierSlug('fast'), 'fast');
  assert.strictEqual(publik.tierSlug('publik-balanced'), 'balanced');
  assert.strictEqual(publik.tierSlug(' Smart '), 'smart');
  assert.strictEqual(publik.tierSlug('gpt-4o'), '');
});

test('pickTier picks the cheapest tier each feature needs', () => {
  assert.strictEqual(publik.pickTier({ mode: 'ask', smart: false }), 'fast');
  assert.strictEqual(publik.pickTier({ mode: 'ask', smart: true }), 'balanced');
  assert.strictEqual(publik.pickTier({ mode: 'recap', smart: true }), 'fast');
  assert.strictEqual(publik.pickTier({ mode: 'leetcode', smart: false }), 'balanced');
  assert.strictEqual(publik.pickTier({ mode: 'unknown', smart: false }), 'fast');
});

test('pickTier never gives an unlinked install publik-smart', () => {
  assert.strictEqual(publik.pickTier({ mode: 'leetcode', smart: true, claimed: false }), 'balanced');
  assert.strictEqual(publik.pickTier({ mode: 'leetcode', smart: true, claimed: true }), 'smart');
  assert.strictEqual(publik.pickTier({ requested: 'smart', claimed: false }), 'balanced');
});

test('an explicit tier slug wins over the feature default', () => {
  assert.strictEqual(publik.pickTier({ mode: 'recap', requested: 'balanced' }), 'balanced');
});

test('planCall returns a tier model, or null when the user typed their own model', () => {
  const base = { smart: true, publik: { claimState: 'anonymous' }, models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } } };
  assert.deepStrictEqual(publik.planCall({ mode: 'ask', settings: base }), { tier: 'balanced', model: 'publik-balanced' });
  const own = { ...base, models: { publik: { fast: 'my-model', smart: 'publik-balanced' } } };
  assert.strictEqual(publik.planCall({ mode: 'ask', settings: own }), null);
});

test('formatCallLog writes one line with no key in it', () => {
  const h = publik.readGatewayHeaders({ 'x-publik-model': 'publik-fast', 'x-publik-request-id': 'req_1', 'x-publik-balance': '40000', 'x-publik-charge-micros': '120' });
  const line = publik.formatCallLog({ mode: 'ask', tier: 'fast', model: 'publik-fast', h, ms: 812.4 });
  assert.strictEqual(line, '[publik] mode=ask tier=fast model=publik-fast charge=$0.0001 balance=$0.04 request=req_1 ms=812 status=ok');
  assert.ok(!/pk_|pat_/.test(line));
  assert.strictEqual(publik.formatCallLog({ mode: 'say', tier: 'fast', model: 'publik-fast', status: 'error' }), '[publik] mode=say tier=fast model=publik-fast status=error');
});
