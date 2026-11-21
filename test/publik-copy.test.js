// Copy rule (CONTRACT §1, R25 S7), mirrored from publik's own copy guard:
// in every file that talks about publik API the strings "OpenAI API access",
// "ChatGPT credits", "credits" as a unit, and any per-token dollar figure are
// forbidden. Money is shown in dollars; "credit" (singular, meaning balance)
// is fine. The provider is always called "publik API".
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['src/publik.js', 'src/llm.js', 'src/store.js', 'main.js', 'renderer/renderer.js', 'renderer/index.html', 'renderer/publik-card.js'];
const FORBIDDEN = [
  /OpenAI API access/i,
  /ChatGPT credits?/i,
  /\bcredits\b/i,
  /\$\s?\d[\d.,]*\s*(?:per|\/)\s*(?:\d+[kKmM]?\s*)?(?:million\s+|thousand\s+|1[kKmM]\s+)?tokens?\b/i,
  /\bper[- ]token\b/i
];

for (const rel of FILES) {
  test(`${rel} obeys the publik API copy rule`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const re of FORBIDDEN) {
      const m = re.exec(text);
      assert.equal(m, null, `${rel} contains forbidden copy: ${m && JSON.stringify(m[0])}`);
    }
  });
}

test('the provider is labelled "publik API", never "Custom" or a vendor name', () => {
  const publik = require('../src/publik-ui');
  assert.equal(publik.PROVIDER_LABEL, 'publik API');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  // Settings opens on a tab named for publik; the brand is lowercase.
  assert.match(html, /id="s-tab-main"[^>]*>🪙 publik</);
  const { formatProviderErrorMessage } = require('../src/llm');
  const err = Object.assign(new Error('x'), { status: 404 });
  assert.match(String(formatProviderErrorMessage(err, 'publik', 'm').message), /publik API/);
  for (const [key, value] of Object.entries(publik.COPY.disclosure)) {
    assert.doesNotMatch(value, /OpenAI|ChatGPT|Anthropic|Gemini/, `disclosure.${key} names a vendor`);
  }
  // No hourly-cost figure (R25 S17): the rate and the monthly line only.
  assert.doesNotMatch(JSON.stringify(publik.COPY), /(?:per|an|\/)\s*hour/i);
  assert.match(publik.COPY.cost, /priced per use at 50% of the model's published list price/);
  assert.match(publik.COPY.cost, /Most people spend under \$2 a month/);
  assert.match(publik.COPY.disclosure.cost, /priced per use at 50% of the model's published list price/);
  assert.match(publik.COPY.disclosure.cost, /Most people spend under \$2 a month/);
  // Policy 0059: a new install holds $0.00; the one free thing is $0.05 when this
  // computer is linked, once. The sheet never promises use before that.
  assert.match(publik.COPY.disclosure.cost, /A new computer starts at \$0\.00\./);
  assert.match(publik.COPY.disclosure.cost, /Linking this computer to your publik account gives \$0\.05 of free use, once\./);
  assert.doesNotMatch(JSON.stringify(publik.COPY.disclosure), /start right away|without an account|free balance|free starter|starts with/i);
});
