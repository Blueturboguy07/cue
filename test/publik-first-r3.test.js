// Round 3 of "publik first" (release 0.2.9), from the v0.2.8 new-customer
// smoke test. The people we will email were on 0.2.4; some pasted home-made
// keys into the OpenAI field, so they upgrade with a bad own key.
//   1 - the first onboarding screen leads with publik (sign-in on step 1);
//   2 - a bad own key: plain words, "Switch to publik" first, "Fix my key"
//       second, on a question and from a free startup check;
//   3 - publik as the provider: Auto transcription is publik, not an old key;
//   4 - a stale "disconnected [Reconnect]" toast goes once publik is live;
//   5 - a dashboard revoke shows at startup (GET /wallet), not "Connected".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('node:module');

// The openai SDK, stubbed: chat requests reject with `chatError`.
let chatError = null;
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: () => (chatError ? Promise.reject(chatError) : Promise.resolve({ [Symbol.asyncIterator]: async function* () {} })) } };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const rendererSrc = read('renderer', 'renderer.js');
const mainSrc = read('main.js');
const css = read('renderer', 'styles.css');
const html = read('renderer', 'index.html');
const pub = require('../src/publik-ui');
const card = require('../renderer/publik-card');
const { createLLM, formatProviderErrorMessage, isAuthError } = require('../src/llm');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');
const { checkOwnKey } = require('../src/own-key-check');

// The source of one top-level function in a file, by its first line.
function fnFrom(src, head) {
  const start = src.indexOf(head);
  assert.ok(start > -1, `${head} not found`);
  const indent = head.match(/^\s*/)[0];
  const end = src.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > -1, `end of ${head} not found`);
  return src.slice(start, end + indent.length + 3);
}

// ---- 1: the first screen leads with publik --------------------------------

function onboardingSteps({ available }) {
  const literal = rendererSrc.slice(rendererSrc.indexOf('const OB_STEPS = ['), rendererSrc.indexOf('];', rendererSrc.indexOf('const OB_STEPS = [')) + 2);
  const boot = rendererSrc.slice(rendererSrc.indexOf('    if (publikState.available) {\n      OB_STEPS.splice'), rendererSrc.indexOf('    // R4: shortcut hints'));
  assert.ok(boot.length > 0, 'boot splice not found');
  const ctx = vm.createContext({
    isWindows: false, permissionHelp: 'help', permissionButtons: [], sayShortcut: '', assistShortcut: '', quitShortcut: '',
    finishOnboard: () => {}, openSettings: () => {}, publikState: { available },
    publikStep: () => ({ title: 'publik step', buttons: [] })
  });
  vm.runInContext(`${literal.replace('const OB_STEPS', 'var OB_STEPS')}\n${boot}`, ctx);
  return ctx.OB_STEPS;
}

test('1: with publik in the build, step 1 is the publik sign-in and the permissions step comes after it', () => {
  const steps = onboardingSteps({ available: true });
  assert.equal(steps.length, 3);
  assert.equal(steps[0].publik, true);
  assert.equal(steps[1].permissions, true);
  assert.equal(steps[2].title, 'You’re all set');
  assert.ok(!steps.some((st) => st.connectModel), 'no "Connect an AI model" step');
  assert.ok(!steps.some((st) => st.welcome), 'the plain welcome is replaced');
});

test('1: a build without publik keeps the four BYO steps', () => {
  const steps = onboardingSteps({ available: false });
  assert.deepEqual(JSON.parse(JSON.stringify(steps.map((st) => st.title))), ['Welcome to cue', 'Allow cue to see & hear', 'Connect an AI model', 'You’re all set']);
});

function publikStepIn({ obDialog = false, state = {}, provider = 'publik' } = {}) {
  const src = rendererSrc.slice(rendererSrc.indexOf('  const WELCOME_SUB'), rendererSrc.indexOf('  // The first-run card (CONTRACT §12.1)'));
  const ctx = vm.createContext({
    publikState: { copy: pub.COPY, connected: false, revoked: false, ...state },
    settings: { provider }, obDialog, window: { cuePublikCard: card },
    esc: (t) => String(t)
  });
  vm.runInContext(`${src}\nthis.step = publikStep();`, ctx);
  const val = (x) => (typeof x === 'function' ? x() : x);
  const s = ctx.step;
  return { title: val(s.title), body: val(s.body), after: val(s.after), buttons: s.hideButtons() ? [] : s.buttons, raw: s };
}

test('1: step 1 says cue runs on the publik balance with no key, with one blue "Sign in with publik" and a small own-key link', () => {
  const s = publikStepIn();
  assert.equal(s.title, 'Welcome to cue');
  assert.match(s.body, /<div class="ob-lede">cue runs on your publik balance\. You need no API key\.<\/div>/);
  assert.equal(s.buttons[0].label, 'Sign in with publik');
  assert.equal(s.buttons[0].primary, true);
  assert.equal(s.buttons[1].label, 'Use my own key instead');
  assert.equal(s.buttons[1].link, true);
  assert.ok(!s.buttons[1].primary);
  // The step is the consent: cost, data path and terms are on the same screen.
  assert.match(s.after, /<strong>Cost\.<\/strong> Every request is priced per use/);
  assert.match(s.after, /<strong>Where your prompts go\.<\/strong> Your prompts, screenshots/);
  assert.match(s.after, /id="ob-publik-terms"/);
});

test('1: opened as a dialog it keeps its own title and full text; a signed-in computer gets no buttons', () => {
  const dialog = publikStepIn({ obDialog: true });
  assert.equal(dialog.title, 'cue uses publik API');
  assert.match(dialog.body, /<strong>Cost\.<\/strong>/);
  assert.equal(dialog.after, '');
  const live = publikStepIn({ state: { connected: true } });
  assert.deepEqual(live.buttons, []);
  assert.match(live.body, /This computer is signed in\./);
  assert.equal(live.after, '');
});

test('1: renderOnboard paints the fine print under the buttons, the link style, and hides buttons for a signed-in computer', () => {
  const render = fnFrom(rendererSrc, '  function renderOnboard() {');
  assert.match(render, /\$\('#ob-after'\)\.innerHTML = after;/);
  assert.match(render, /if \(b\.link\) el\.classList\.add\('ob-link'\);/);
  assert.match(render, /\(noButtons \? \[\] : step\.buttons \|\| \[\]\)/);
  assert.match(html, /<div class="ob-buttons" id="ob-buttons"><\/div>\s*<!--[^>]*-->\s*<div class="ob-after hidden" id="ob-after"><\/div>/);
  assert.match(css, /\.ob-buttons button\.ob-link \{[^}]*text-decoration: underline;/);
  // The fine print scrolls with the text, so the dialog still fits 600 px (D9).
  assert.match(css, /#onboard > \.ob-after \{ flex: 0 1 auto; min-height: 0; overflow-y: auto; \}/);
});

// ---- 2: a bad own key ------------------------------------------------------

test('2: a 401 / invalid-key answer from an own provider is an auth failure; a rate limit or a bare 403 is not', () => {
  assert.equal(isAuthError(Object.assign(new Error('401 Incorrect API key provided: sk-cue-s***xyz'), { status: 401 })), true);
  assert.equal(isAuthError(Object.assign(new Error('invalid x-api-key'), { status: 401, error: { type: 'authentication_error' } })), true);
  assert.equal(isAuthError(Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 })), true);
  assert.equal(isAuthError(Object.assign(new Error('429 Too Many Requests'), { status: 429 })), false);
  assert.equal(isAuthError(Object.assign(new Error('You do not have access to this model'), { status: 403 })), false);
});

test('2: the message is plain and never echoes the key', () => {
  const raw = Object.assign(new Error('401 Incorrect API key provided: sk-cue-s***xyz. You can find your API key at ...'), { status: 401 });
  const e = formatProviderErrorMessage(raw, 'openai', 'gpt-4o-mini');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'Your OpenAI key did not work.');
  assert.deepEqual(e.ownKeyFailed, { provider: 'openai', providerName: 'OpenAI' });
  assert.doesNotMatch(e.message, /sk-|401/);
  // publik's own 401 keeps its Reconnect path.
  const p = formatProviderErrorMessage(Object.assign(new Error('401'), { status: 401, error: { type: 'key_revoked' } }), 'publik', 'publik-fast');
  assert.ok(!p.ownKeyFailed);
});

test('2: a question with a bad OpenAI key rejects with ownKeyFailed (0.2.4-style file)', async () => {
  chatError = Object.assign(new Error('401 Incorrect API key provided: sk-cue-s***xyz'), { status: 401 });
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: 'sk-cue-smoke-fake' }, models: {} });
  await assert.rejects(() => llm.stream({ system: 's', turns: [{ role: 'user', text: 'What is 2 plus 2?' }], onToken: () => {} }), (e) => {
    assert.equal(e.message, 'Your OpenAI key did not work.');
    assert.equal(e.ownKeyFailed.provider, 'openai');
    return true;
  });
  chatError = null;
});

test('2: the answer offers "Switch to publik" first and "Fix my key" second', () => {
  const m = pub.ownKeyFailedMessage({ providerName: 'OpenAI', publikAvailable: true });
  assert.equal(m.message, 'Your OpenAI key did not work. Switch to publik to use cue with no API key, or fix your key in Settings.');
  assert.deepEqual(m.action, { kind: 'switch', label: 'Switch to publik' });
  assert.deepEqual(m.secondary, { kind: 'fix-key', label: 'Fix my key' });
  const noPublik = pub.ownKeyFailedMessage({ providerName: 'OpenAI', publikAvailable: false });
  assert.deepEqual(noPublik.action, { kind: 'fix-key', label: 'Fix my key' });
  assert.equal(noPublik.secondary, undefined);
  // main.js sends it, marks the key, and clears the mark after a good answer.
  const run = fnFrom(mainSrc, 'async function runFeature(mode, userText) {');
  assert.match(run, /if \(e && e\.ownKeyFailed\) \{\n\s+markOwnKeyFailed\(e\.ownKeyFailed\.provider\);\n\s+send\('llm:error', publik\.ownKeyFailedMessage\(\{ providerName: e\.ownKeyFailed\.providerName, publikAvailable: publikBuild\.available \}\)\);/);
  assert.match(run, /clearOwnKeyFailed\(settings\.provider\);/);
  // The renderer paints both buttons; the second is quiet.
  assert.match(rendererSrc, /cue\.on\('llm:error', \(\{ message, action, secondary \}\) => \{/);
  assert.match(rendererSrc, /showStatus\(message, \[publikActionButton\(action\), publikActionButton\(secondary, true\)\]\);/);
  assert.match(fnFrom(rendererSrc, '  function publikActionButton(action, secondary) {'), /'fix-key'\) \{\n\s+btn\.textContent = action\.label \|\| 'Fix my key';\n\s+btn\.addEventListener\('click', \(\) => fixOwnKey\(\)\);/);
  assert.match(css, /#cue-status button\[data-kind="switch"\][^{]*\{ border-color: transparent; background: var\(--accent\); color: #fff; \}/);
});

test('2: the overlay and the Settings card say the key did not work, with publik first', () => {
  const p = { available: true, connected: false, ownKeyFailed: { provider: 'openai', providerName: 'OpenAI' } };
  const settings = { provider: 'openai', apiKeys: { openai: 'sk-cue-smoke-fake' } };
  assert.equal(card.providerReady(settings, p), true, 'the key is there, so the old rule showed nothing');
  const prompt = card.setupPrompt(settings, p);
  assert.equal(prompt.title, 'Your OpenAI key did not work');
  assert.deepEqual(prompt.primary, { kind: 'switch', label: 'Switch to publik' });
  assert.deepEqual(prompt.secondary, { kind: 'fix-key', label: 'Fix my key' });
  const view = card.cardView(p, 'openai');
  assert.equal(view.status, 'Your OpenAI key did not work.');
  assert.equal(view.warn, true);
  assert.equal(view.primary.kind, 'switch');
  // Another provider selected, or no failure: the old views.
  assert.equal(card.setupPrompt({ provider: 'groq', apiKeys: { groq: 'gsk' } }, p), null);
  assert.equal(card.cardView({ available: true }, 'openai').status, 'You use your own OpenAI key now.');
  assert.match(fnFrom(rendererSrc, '  async function runSetupAction(kind) {'), /else if \(kind === 'fix-key'\) fixOwnKey\(\);/);
});

function fakeFetch(status, body = '') {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status, ok: status >= 200 && status < 300, text: async () => body }; };
  fn.calls = calls;
  return fn;
}

test('2: the startup check is a free "list models" call: 401 is bad, 200 is ok, anything else is unknown', async () => {
  const bad = fakeFetch(401);
  assert.equal(await checkOwnKey({ provider: 'openai', apiKey: 'sk-cue-smoke-fake', fetchImpl: bad }), 'bad');
  assert.equal(bad.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(bad.calls[0].init.method, 'GET');
  assert.equal(await checkOwnKey({ provider: 'openai', apiKey: 'k', fetchImpl: fakeFetch(200) }), 'ok');
  assert.equal(await checkOwnKey({ provider: 'openai', apiKey: 'k', fetchImpl: fakeFetch(500) }), 'unknown');
  assert.equal(await checkOwnKey({ provider: 'openai', apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), 'unknown');
  const gemini = fakeFetch(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
  assert.equal(await checkOwnKey({ provider: 'gemini', apiKey: 'AIza-fake', fetchImpl: gemini }), 'bad');
  assert.doesNotMatch(gemini.calls[0].url, /AIza/, 'the key goes in a header, never in the URL');
  const none = fakeFetch(401);
  assert.equal(await checkOwnKey({ provider: 'custom', apiKey: 'k', fetchImpl: none }), 'unknown');
  assert.equal(none.calls.length, 0, 'no free check for a custom endpoint');
});

test('2: main.js runs the check at startup and after a new own key, and hands the result over in its view', () => {
  assert.match(fnFrom(mainSrc, 'function launchApp() {'), /registerShortcuts\(\);\n\s+startupChecks\(\);\n\}/);
  assert.match(fnFrom(mainSrc, 'function checkSelectedOwnKey() {'), /if \(!provider \|\| provider === publik\.PUBLIK_PROVIDER \|\| !key\) return;/);
  assert.match(fnFrom(mainSrc, 'function checkSelectedOwnKey() {'), /if \(verdict === 'bad' && now\.provider === provider && now\.apiKeys\[provider\] === key\) markOwnKeyFailed\(provider\);/);
  assert.match(mainSrc, /if \(next\.provider !== beforeProvider \|\| nextKey !== beforeKey\) \{\n\s+if \(ownKeyFailure && !ownKeyFailedFor\(next\)\) \{ ownKeyFailure = null; publikPush\(\); \}\n\s+checkSelectedOwnKey\(\);/);
  assert.match(fnFrom(mainSrc, 'function publikState() {'), /ownKeyFailed: ownKeyFailedFor\(s\),/);
  // Only a hash of the key is kept, in memory.
  assert.match(mainSrc, /ownKeyFailure = \{ provider, keyHash: ownKeyHash\(key\) \};/);
});

// ---- 3: publik as the provider transcribes through publik ------------------

const PUBLIK_KEY = 'pk_test_r3';
function publikSettings(over = {}) {
  return { provider: 'publik', sttProvider: 'auto', apiKeys: { publik: PUBLIK_KEY, openai: 'sk-cue-smoke-fake' }, publik: { baseUrl: 'https://publikhq.com/api/v1', revoked: false }, models: {}, localWhisper: {}, ...over };
}

test('3: publik + Auto with an old OpenAI key: batch audio goes to publik only', () => {
  assert.deepEqual(createSTT(publikSettings()).providers, ['publik']);
  // The own key only when picked on the Audio tab.
  assert.deepEqual(createSTT(publikSettings({ sttProvider: 'openai' })).providers, ['openai']);
  // An own provider keeps its own Auto chain.
  assert.deepEqual(createSTT({ provider: 'openai', sttProvider: 'auto', apiKeys: { openai: 'sk' }, models: {} }).providers, ['openai']);
  // publik not live: no fallback to the old key.
  assert.equal(createSTT(publikSettings({ publik: { revoked: true } })).available, false);
});

test('3: publik + Auto never opens OpenAI Realtime with the old key; an explicit OpenAI choice still does', () => {
  const cb = { onTranscript: () => {}, onInterim: () => {}, onError: () => {}, onStatusChange: () => {} };
  const auto = createStreamingSTT(publikSettings(), 'you', cb);
  assert.equal(auto.type, 'batch');
  assert.equal(auto.provider, 'publik');
  const picked = createStreamingSTT(publikSettings({ sttProvider: 'openai' }), 'you', cb);
  assert.equal(picked.provider, 'openai-realtime');
  // Settings says what is used.
  assert.match(rendererSrc, /const automaticStt = settings\.provider === 'publik'\n\s+\? \(publikStt \? 'publik API' : 'none'\)/);
});

// ---- 4: a stale toast goes once publik is live -----------------------------

function toastHarness({ actions, show = true, provider = 'publik' }) {
  const el = { dataset: { actions }, classList: { set: new Set(show ? ['show'] : []), contains(c) { return this.set.has(c); }, remove(c) { this.set.delete(c); } } };
  const src = rendererSrc.slice(rendererSrc.indexOf('  const PUBLIK_FIX_KINDS'), rendererSrc.indexOf('  cue.on(\'status\''));
  const ctx = vm.createContext({ document: { getElementById: () => el }, settings: { provider }, statusTimer: null, clearTimeout: () => {} });
  vm.runInContext(`${src}\nthis.clear = clearStalePublikToast;`, ctx);
  return { el, clear: ctx.clear };
}

test('4: after Reconnect works, the old "disconnected [Reconnect]" toast is cleared', () => {
  const live = { connected: true, revoked: false };
  const stale = toastHarness({ actions: 'reconnect' });
  assert.equal(stale.clear(live), true);
  assert.equal(stale.el.classList.contains('show'), false);
  // A plain status toast, a still-revoked key, or another provider: kept.
  assert.equal(toastHarness({ actions: '' }).clear(live), false);
  assert.equal(toastHarness({ actions: 'reconnect' }).clear({ connected: true, revoked: true }), false);
  assert.equal(toastHarness({ actions: 'switch fix-key', provider: 'openai' }).clear(live), false);
  // After "Switch to publik" the "key did not work" toast goes too.
  assert.equal(toastHarness({ actions: 'switch fix-key' }).clear(live), true);
});

test('4: every publik path reaches the clear (renderSetupCta), the toast switch button included', () => {
  assert.match(fnFrom(rendererSrc, '  function renderSetupCta() {'), /if \(!settings \|\| !publikState\) return false;\n\s+clearStalePublikToast\(publikState\);/);
  assert.match(fnFrom(rendererSrc, '  async function switchToPublik() {'), /renderSetupCta\(\);\n\s+\}\s*$/);
  assert.match(rendererSrc, /cue\.on\('publik:state', \(state\) => \{ publikState = state; renderPublikBlock\(\); renderSetupCta\(\);/);
  assert.match(fnFrom(rendererSrc, '  function showStatus(message, button) {'), /el\.dataset\.actions = buttons\.map\(\(b\) => b\.dataset\.kind \|\| ''\)\.join\(' '\);/);
});

// ---- 5: a dashboard revoke shows at startup --------------------------------

function startupHarness(settings) {
  const calls = { wallet: 0, ownKey: 0 };
  const ctx = vm.createContext({
    store: { getSettings: () => settings }, publikBuild: { available: true },
    publikRefreshWallet: async () => { calls.wallet++; }, checkSelectedOwnKey: () => { calls.ownKey++; }
  });
  vm.runInContext(`${fnFrom(mainSrc, 'function startupChecks() {')}\nthis.run = startupChecks;`, ctx);
  ctx.run();
  return calls;
}

test('5: startup reads the wallet once (GET /wallet, free) when a publik key is on disk and not yet marked revoked', () => {
  assert.equal(startupHarness({ provider: 'publik', apiKeys: { publik: 'pk' }, publik: { revoked: false } }).wallet, 1);
  assert.equal(startupHarness({ provider: 'publik', apiKeys: { publik: 'pk' }, publik: { revoked: true } }).wallet, 0);
  assert.equal(startupHarness({ provider: 'publik', apiKeys: { publik: '' }, publik: {} }).wallet, 0);
  assert.equal(startupHarness({ provider: 'openai', apiKeys: { openai: 'sk' }, publik: {} }).ownKey, 1);
});

test('5: a wallet 401 marks the key revoked, and the overlay and card show Reconnect at once', async () => {
  const stored = { provider: 'publik', apiKeys: { publik: 'pk' }, publik: { revoked: false, disconnected: false } };
  let pushed = 0;
  const ctx = vm.createContext({
    store: { getSettings: () => stored, setPublik: (patch) => Object.assign(stored.publik, patch) },
    publikBuild: { baseUrl: 'https://publikhq.com/api/v1' },
    // src/publik.js readWallet answers a 401 as a null wallet, never a throw.
    publikModule: { readWallet: async () => ({ status: 401, wallet: null, message: 'This computer was removed from your publik account.' }) },
    publik: { normalizeWallet: (w) => w },
    publikPush: () => { pushed++; }, publikState: () => ({}), publikProvision: async () => {}, recordEvent: () => {}, Date
  });
  vm.runInContext(`${fnFrom(mainSrc, 'async function publikRefreshWallet() {')}\n${fnFrom(mainSrc, 'function publikHandleRevoked(e) {')}\nthis.run = publikRefreshWallet;`, ctx);
  await ctx.run();
  assert.equal(stored.publik.revoked, true);
  assert.equal(stored.publik.disconnected, true);
  assert.equal(pushed, 1);
  const view = { available: true, connected: true, revoked: true, disconnected: true, disclosureAccepted: 1, lastError: '', status: pub.statusLine({ connected: true, revoked: true }) };
  assert.equal(card.setupPrompt({ provider: 'publik', apiKeys: {} }, view).primary.label, 'Reconnect');
  assert.equal(card.cardView(view, 'publik').primary.kind, 'reconnect');
});
