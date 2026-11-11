const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Owner report on 0.2.6: "I still don't really see a publik API sign in
// anywhere ... I just see keys." Paying users cancelled with "Its not giving me
// the option to use on Cue". Settings now opens on a publik tab whose first
// element is the publik card with one primary button; every key and provider
// control sits in a closed "Use your own API key instead" section at the
// bottom; the overlay says "Sign in with publik" while nothing can answer.

const root = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const card = require('../renderer/publik-card.js');

// Source of one renderer function (sync or async), up to its closing brace.
function fnSrc(name) {
  let start = rendererSrc.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in renderer.js`);
  if (rendererSrc.slice(start - 6, start) === 'async ') start -= 6;
  const end = rendererSrc.indexOf('\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return rendererSrc.slice(start, end + 4);
}

function fakeElement(initial = ['hidden']) {
  const classes = new Set(initial);
  return {
    textContent: '', value: '', open: false, disabled: false,
    focus() {}, scrollIntoView() {},
    classList: {
      toggle(name, on) { if (on === undefined) on = !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

function fakeDom() {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, fakeElement()); return els.get(id); };
  return { $, els };
}

const COPY = { cost: 'c', dataPath: 'd', whyItCostsToggle: 'w', whyItCosts: 'ww' };
const CLAIM = 'https://publikhq.com/claim/abc';
const BASE = {
  available: true, connected: false, revoked: false, disconnected: false, disclosureAccepted: 0, claimState: 'anonymous',
  copy: COPY, status: { text: 'Not set up yet — no key needed to set it up.', warn: false },
  settingsCta: null, lowStarter: null, addCreditUrl: '', claimUrl: '', wallet: null, balanceMicros: null, line: ''
};
const ANON = { ...BASE, connected: true, disclosureAccepted: 1, keyId: 'k1', claimUrl: CLAIM, balanceMicros: 0, status: { text: 'Connected · key k1 · Ready · $0.00 left', warn: false } };
const LINKED = {
  ...ANON, claimState: 'claimed', claimUrl: '', balanceMicros: 3120000, line: 'Linked to your publik account · $3.12 left',
  wallet: { claimState: 'claimed', balanceMicros: 3120000, planId: 'basic' },
  settingsCta: { label: 'Manage plan', url: 'https://publikhq.com/dashboard/api' }
};

// Runs the real renderPublikBlock against fake elements.
function renderWith(publikState, settings) {
  const { $ } = fakeDom();
  const ctx = vm.createContext({ $, publikState, settings, statusText: () => 'status', window: { cuePublikCard: card } });
  vm.runInContext(`${fnSrc('renderPublikBlock')}\nrenderPublikBlock();`, ctx);
  return $;
}

// ---- index.html: the first tab --------------------------------------------

const pane = (() => {
  const start = html.indexOf('data-pane="keys"');
  return html.slice(start, html.indexOf('<!-- Tab: Transcription -->', start));
})();
const byoStart = pane.indexOf('<details id="byo-section"');
const byo = pane.slice(byoStart, pane.indexOf('</details>', pane.indexOf('<div class="byo-body">')) + 10);

test('Settings opens on a first tab named for publik', () => {
  const tabs = [...html.matchAll(/<button class="s-tab[^"]*" data-tab="([^"]+)"[^>]*>([^<]*)</g)];
  assert.equal(tabs[0][1], 'keys');
  assert.match(tabs[0][0], /class="s-tab on"/, 'the first tab is the one shown');
  assert.equal(tabs[0][2], '🪙 publik');
  assert.doesNotMatch(html, /API Keys<\/button>/, 'no tab ships named "API Keys"');
  // openSettings always lands on that tab, with the own-key section closed.
  const open = fnSrc('openSettings');
  assert.match(open, /showSettingsTab\('keys'\)/);
  assert.match(open, /byo\.open = !\(publikState && publikState\.available\)/);
});

test('the publik card is the first thing in the publik tab', () => {
  const firstElement = pane.slice(pane.indexOf('>') + 1).match(/<(?!!--)([a-z]+)[^>]*>/);
  assert.match(firstElement[0], /id="publik-settings"/);
  assert.ok(pane.indexOf('id="publik-settings"') < pane.indexOf('id="model-fast"'));
  assert.ok(pane.indexOf('id="publik-primary"') > -1, 'the card has one primary button');
});

test('every key and provider control is inside the closed own-key section at the bottom', () => {
  assert.ok(byoStart > -1, '#byo-section not found');
  assert.match(byo, /^<details id="byo-section" class="byo-section">/, 'no open attribute: closed by default');
  assert.match(byo, /Use your own API key instead/);
  for (const id of ['provider-seg', 'key-cerebras', 'key-openai', 'key-anthropic', 'key-gemini', 'key-deepgram', 'key-groq', 'key-custom',
    'key-minimax', 'key-ollama', 'key-deepseek', 'key-azure', 'custom-endpoint-settings', 'azure-endpoint-settings', 'minimax-region-settings', 'base-url']) {
    assert.ok(byo.includes(`id="${id}"`), `${id} must be inside #byo-section`);
    assert.equal(pane.split(`id="${id}"`).length, 2, `${id} appears once`);
  }
  assert.match(byo, /stored locally · never sent to any server/);
  // Nothing before the section asks for a key.
  assert.doesNotMatch(pane.slice(0, byoStart), /type="password"/);
  // The provider row has no publik button: the card is the way to publik.
  assert.doesNotMatch(byo, /data-provider="publik"/);
  // Models and Assistant access stay outside the closed section.
  for (const id of ['model-fast', 'model-smart', 'applink-callers']) {
    assert.ok(pane.indexOf(`id="${id}"`) > -1 && pane.indexOf(`id="${id}"`) < byoStart, `${id} stays usable outside the section`);
  }
  // The section is the last block of the tab (only the status line follows).
  assert.match(pane.slice(pane.indexOf('</details>', byoStart + 1)), /^<\/details>\s*<div class="s-status" id="s-status"><\/div>\s*<\/div>/);
});

test('a build with no publik names the tab for keys and opens the key section', () => {
  const boot = rendererSrc.slice(rendererSrc.indexOf('(async function boot()'));
  assert.match(boot, /if \(!publikState\.available\) \{\n\s+\$\('#s-tab-main'\)\.textContent = '🔑 API Keys';/);
  const $ = renderWith({ ...BASE, available: false }, { provider: 'openai', apiKeys: { openai: 'sk-test' } });
  assert.equal($('#publik-settings').classList.contains('hidden'), true, 'no publik card without publik');
});

// ---- the card: one primary button per state ------------------------------

test('not connected: the card says no key is needed and offers "Sign in with publik"', () => {
  const v = card.cardView(BASE, 'publik');
  assert.equal(v.show, true);
  assert.match(v.lede, /publik balance/);
  assert.match(v.lede, /no API key/);
  assert.equal(v.status, 'Not connected.');
  assert.deepEqual(v.primary, { kind: 'signin', label: 'Sign in with publik' });
  const $ = renderWith(BASE, { provider: 'publik', apiKeys: {} });
  assert.equal($('#publik-settings').classList.contains('hidden'), false);
  assert.equal($('#publik-primary').textContent, 'Sign in with publik');
  assert.equal($('#publik-primary').classList.contains('hidden'), false);
  assert.equal($('#publik-disconnect').classList.contains('hidden'), true);
});

test('connected but not linked: the one button opens the claim link to sign in', () => {
  const v = card.cardView(ANON, 'publik');
  assert.deepEqual(v.primary, { kind: 'link', label: 'Sign in with publik', url: CLAIM });
  assert.match(v.status, /not linked/);
  assert.equal(v.disconnect, true);
  // A claim link off publikhq.com never becomes a button.
  assert.equal(card.cardView({ ...ANON, claimUrl: 'https://evil.example/claim' }, 'publik').primary, null);
});

test('linked: balance shown, no primary, "Manage plan" and Disconnect stay secondary', () => {
  const v = card.cardView(LINKED, 'publik');
  assert.equal(v.primary, null);
  assert.match(v.status, /\$3\.12 left/);
  assert.deepEqual(v.manage, { label: 'Manage plan', url: 'https://publikhq.com/dashboard/api' });
  const $ = renderWith(LINKED, { provider: 'publik', apiKeys: {} });
  assert.equal($('#publik-primary').classList.contains('hidden'), true);
  assert.equal($('#publik-manage').textContent, 'Manage plan');
  assert.equal($('#publik-disconnect').classList.contains('hidden'), false);
});

test('low balance: the one button is "Add a plan or pack"', () => {
  const low = { ...LINKED, balanceMicros: 120000, line: '', addCreditUrl: 'https://publikhq.com/dashboard/api?add=1', wallet: { ...LINKED.wallet, balanceMicros: 120000 } };
  const v = card.cardView(low, 'publik');
  assert.deepEqual(v.primary, { kind: 'credit', label: 'Add a plan or pack', url: 'https://publikhq.com/dashboard/api?add=1' });
  assert.equal(v.warn, true);
  assert.match(v.status, /Low balance · \$0\.12 left/);
});

test('revoked or disconnected: the one button is "Reconnect" and the status is the gateway sentence', () => {
  const revoked = card.cardView({ ...ANON, revoked: true, status: { text: 'publik API key was revoked. Reconnect to set this computer up again.', warn: true } }, 'publik');
  assert.deepEqual(revoked.primary, { kind: 'reconnect', label: 'Reconnect' });
  assert.match(revoked.status, /revoked/);
  const gone = card.cardView({ ...BASE, disclosureAccepted: 1, disconnected: true, status: { text: 'publik API is disconnected.', warn: true } }, 'publik');
  assert.deepEqual(gone.primary, { kind: 'reconnect', label: 'Reconnect' });
});

// ---- 0.2.4 settings file: provider=openai --------------------------------

test('a 0.2.4 settings file with provider=openai still shows the publik card with "Switch to publik"', () => {
  for (const state of [BASE, { ...BASE, disclosureAccepted: 1 }, ANON, LINKED]) {
    const $ = renderWith(state, { provider: 'openai', apiKeys: { openai: 'sk-test' } });
    assert.equal($('#publik-settings').classList.contains('hidden'), false, 'card visible');
    assert.equal($('#publik-primary').textContent, 'Switch to publik');
    assert.equal($('#publik-primary').classList.contains('hidden'), false);
    assert.equal($('#publik-status-note').textContent, 'You use your own OpenAI key now.');
  }
});

function switchHarness({ publikState, settings }) {
  const calls = { accept: 0, disclosure: 0, claim: 0 };
  const { $ } = fakeDom();
  const ctx = vm.createContext({
    $, publikState, settings,
    document: { querySelectorAll: () => [] },
    cue: {
      publikAcceptDisclosure: async () => { calls.accept++; return { ...ANON }; },
      settingsGet: async () => ({ provider: 'publik', models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } } })
    },
    showPublikDisclosure: () => { calls.disclosure++; },
    openClaimLink: async () => { calls.claim++; return true; },
    updateCustomProviderFields: () => {}, renderPublikBlock: () => {}, statusText: () => '', updateSmartTooltip: () => {}, renderSetupCta: () => {}
  });
  vm.runInContext(`${fnSrc('adoptPublikSelection')}\n${fnSrc('switchToPublik')}\nthis.run = switchToPublik;`, ctx);
  return { ctx, calls, $ };
}

test('"Switch to publik" selects publik, keeps the own key, and goes on to sign in', async () => {
  const settings = { provider: 'openai', apiKeys: { openai: 'sk-test' }, models: { openai: { fast: 'gpt', smart: 'gpt' } } };
  const { ctx, calls, $ } = switchHarness({ publikState: { ...BASE, disclosureAccepted: 1 }, settings });
  await ctx.run();
  assert.equal(calls.accept, 1, 'publik:accept-disclosure selects publik in main');
  assert.equal(ctx.settings.provider, 'publik');
  assert.deepEqual(ctx.settings.models.publik, { fast: 'publik-fast', smart: 'publik-balanced' }, 'models from main, not stale');
  assert.equal(ctx.settings.apiKeys.openai, 'sk-test', 'the own key is kept');
  assert.equal($('#model-fast').value, 'publik-fast');
  assert.equal(calls.claim, 1, 'then the claim link (sign in) opens');
});

test('"Switch to publik" before consent shows the disclosure and mints nothing', async () => {
  const settings = { provider: 'openai', apiKeys: { openai: 'sk-test' }, models: {} };
  const { ctx, calls } = switchHarness({ publikState: { ...BASE }, settings });
  await ctx.run();
  assert.equal(calls.disclosure, 1);
  assert.equal(calls.accept, 0);
  assert.equal(ctx.settings.provider, 'openai');
});

// The renderer never sees the publik key (apiKeys.publik is always ''), so
// the old "switch to any saved key" rule sent a person who had just picked
// publik straight back to their 0.2.4 OpenAI key on Save.
function saveHarness({ provider, keysAtOpen, typed }) {
  const { $ } = fakeDom();
  for (const [id, value] of Object.entries(typed)) $(`#${id}`).value = value;
  $('#whisper-language').value = 'auto';
  const settings = { provider, apiKeys: { ...keysAtOpen, publik: '' }, models: {}, localWhisper: {}, slides: {} };
  const ctx = vm.createContext({
    $, settings, keysAtOpen: { ...keysAtOpen, publik: '' }, publikState: null,
    cue: { settingsSet: async (s) => s },
    clampOpacity: (v) => v, statusText: () => '', updateSmartTooltip: () => {}, renderSetupCta: () => {}
  });
  vm.runInContext(`${fnSrc('saveSettings')}\nthis.run = saveSettings;`, ctx);
  return ctx;
}

test('Save keeps publik selected when an old OpenAI key is still saved', async () => {
  const ctx = saveHarness({ provider: 'publik', keysAtOpen: { openai: 'sk-old' }, typed: { 'key-openai': 'sk-old' } });
  assert.equal(await ctx.run(), true);
  assert.equal(ctx.settings.provider, 'publik');
});

test('Save still follows a key typed during this visit (the original intent)', async () => {
  const ctx = saveHarness({ provider: 'publik', keysAtOpen: { openai: '' }, typed: { 'key-openai': 'sk-new' } });
  await ctx.run();
  assert.equal(ctx.settings.provider, 'openai');
});

// ---- first run: the overlay -----------------------------------------------

test('first run with nothing connected: the overlay names publik, not a key', () => {
  const settings = { provider: 'publik', apiKeys: { publik: '' } };
  const prompt = card.setupPrompt(settings, BASE);
  assert.equal(prompt.title, 'Sign in to start');
  assert.match(prompt.body, /publik/);
  assert.match(prompt.body, /no API key/);
  assert.doesNotMatch(`${prompt.title} ${prompt.body} ${prompt.primary.label}`, /add (an|your)\b.*key|paste|enter .*key/i);
  assert.deepEqual(prompt.primary, { kind: 'signin', label: 'Sign in with publik' });
  // Own provider with no key, publik in the build: still publik first.
  const own = card.setupPrompt({ provider: 'openai', apiKeys: { openai: '' } }, BASE);
  assert.deepEqual(own.primary, { kind: 'switch', label: 'Sign in with publik' });
  // Revoked: Reconnect.
  assert.equal(card.setupPrompt(settings, { ...ANON, connected: false, disconnected: true }).primary.label, 'Reconnect');
  // The mint failed (for example a rate limit): say so, and offer Reconnect.
  const failed = card.setupPrompt(settings, { ...BASE, disclosureAccepted: 1, lastError: 'Too many provisioning requests from this network.', problem: 'publik is limiting new setups from this network. Try again in 41 minutes.' });
  assert.equal(failed.title, 'Setup did not finish');
  assert.equal(failed.body, 'publik is limiting new setups from this network. Try again in 41 minutes.');
  assert.equal(failed.primary.label, 'Reconnect');
  // The raw gateway text never becomes the body, even without a plain sentence.
  assert.doesNotMatch(card.setupPrompt(settings, { ...BASE, disclosureAccepted: 1, lastError: 'fetch failed' }).body, /fetch failed/);
  // Set up but not linked, $0.00: still "Sign in with publik" (the claim link).
  assert.deepEqual(card.setupPrompt(settings, ANON).primary, { kind: 'link', label: 'Sign in with publik' });
  assert.equal(card.setupPrompt(settings, ANON).title, 'Finish signing in');
  assert.match(fnSrc('runSetupAction'), /kind === 'link'\) await openClaimLink\(\)/);
  // Ready → no prompt (linked, or an unlinked computer that still has a balance).
  assert.equal(card.setupPrompt(settings, LINKED), null);
  assert.equal(card.setupPrompt(settings, { ...ANON, balanceMicros: 30000 }), null);
  assert.equal(card.setupPrompt({ provider: 'openai', apiKeys: { openai: 'sk' } }, BASE), null);
  // Only a build without publik asks for a key.
  assert.match(card.setupPrompt(settings, { ...BASE, available: false }).body, /API key/);
});

test('boot shows the sign-in prompt instead of the example conversation', () => {
  const boot = rendererSrc.slice(rendererSrc.indexOf('(async function boot()'));
  assert.match(boot, /if \(!renderSetupCta\(\)\) showExample\(\);/);
  assert.match(rendererSrc, /cue\.on\('publik:state', \(state\) => \{ publikState = state; renderPublikBlock\(\); renderSetupCta\(\);/);
  assert.match(fnSrc('runSetupAction'), /kind === 'signin'\) await signInWithPublik\(\)/);
});

test('every "add a key" message points at publik first', () => {
  const llm = fs.readFileSync(path.join(root, 'src', 'llm.js'), 'utf8');
  assert.match(llm, /configurationError = 'Sign in with publik to start\./);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /publikBuild\.available\n\s+\? \{ message: publik\.ownProviderNotReadyMessage\(\{ providerName: llm\.providerName, missingKey: llm\.missingKey, configurationError: message \}\), action: \{ kind: 'switch' \} \}/);
  assert.match(main, /send\('llm:error', publik\.notReadyMessage\(publikState\(\)\)\);/);
  assert.doesNotMatch(main, /No transcription key set/);
  assert.match(main, /Transcription is off\. Switch to publik in Settings to transcribe with no API key\./);
  assert.match(main, /Pick Local in Settings › Audio to transcribe on this computer with no key/);
  const pub = require('../src/publik-ui');
  assert.equal(pub.COPY.disclosure.accept, 'Sign in with publik');
  assert.match(fnSrc('publikActionButton'), /'disclosure'\) \{\n\s+btn\.textContent = 'Sign in with publik';/);
  assert.match(fnSrc('publikActionButton'), /'switch'\) \{\n\s+btn\.textContent = 'Switch to publik';/);
  assert.doesNotMatch(rendererSrc, /cue uses API keys for/);
});

test('index.html loads publik-card.js before renderer.js (same file on Windows and Mac)', () => {
  assert.ok(html.indexOf('<script src="publik-card.js"></script>') > -1);
  assert.ok(html.indexOf('publik-card.js') < html.indexOf('renderer.js'));
});

// ---- round 2 (blind verifier on 93fd2ee) ----------------------------------

const pub = require('../src/publik-ui');

test('D1: linked with a healthy balance: no blue button, "Add a plan or pack" back as a secondary', () => {
  const v = card.cardView({ ...LINKED, addCreditUrl: 'https://publikhq.com/dashboard/api?add=1' }, 'publik');
  assert.equal(v.primary, null);
  assert.equal(v.warn, false);
  assert.deepEqual(v.credit, { label: 'Add a plan or pack', url: 'https://publikhq.com/dashboard/api?add=1' });
  assert.deepEqual(v.manage, { label: 'Manage plan', url: 'https://publikhq.com/dashboard/api' });
  assert.match(html, /<button id="publik-add-credit" class="s-action hidden">Add a plan or pack<\/button>/);
  const $ = renderWith({ ...LINKED, addCreditUrl: 'https://publikhq.com/dashboard/api?add=1' }, { provider: 'publik', apiKeys: {} });
  assert.equal($('#publik-primary').classList.contains('hidden'), true);
  assert.equal($('#publik-add-credit').classList.contains('hidden'), false);
  assert.equal($('#publik-add-credit').textContent, 'Add a plan or pack');
});

test('D2: own provider with no key: publik first, proper provider name', () => {
  assert.equal(pub.ownProviderNotReadyMessage({ providerName: 'OpenAI', missingKey: true, configurationError: 'Add your OpenAI key in Settings.' }),
    'Switch to publik, or add your OpenAI key in Settings.');
  assert.equal(pub.ownProviderNotReadyMessage({ providerName: 'Azure AI Foundry', missingKey: false, configurationError: 'Add your Azure AI Foundry endpoint in Settings.' }),
    'Switch to publik, or add your Azure AI Foundry endpoint in Settings.');
  const { createLLM } = require('../src/llm');
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: '' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } });
  assert.equal(llm.configurationError, 'Add your OpenAI key in Settings.');
  assert.equal(pub.ownProviderNotReadyMessage(llm).startsWith('Switch to publik, or add your OpenAI key'), true);
});

test('D3: after a failed setup the message and the button agree', () => {
  const failed = pub.notReadyMessage({ disclosureAccepted: 1, lastError: 'fetch failed', lastErrorKind: 'network' });
  assert.equal(failed.action.label, 'Reconnect');
  assert.equal(failed.message, 'Setup did not finish. cue could not reach publik. Check your internet connection, then try again.');
  assert.doesNotMatch(failed.message, /Sign in with publik|fetch failed/);
  // The shape main.js really passes: its publikState() view (problem, no kind fields).
  const viewShaped = pub.notReadyMessage({ disclosureAccepted: 1, lastError: 'fetch failed', problem: 'cue could not reach publik. Check your internet connection, then try again.' });
  assert.equal(viewShaped.message, 'Setup did not finish. cue could not reach publik. Check your internet connection, then try again.');
  const fresh = pub.notReadyMessage({ disclosureAccepted: 0 });
  assert.equal(fresh.action.kind, 'disclosure');
  assert.match(fresh.message, /^Sign in with publik/);
  assert.match(fnSrc('publikActionButton'), /'disclosure'\) \{\n\s+btn\.textContent = 'Sign in with publik';/);
  const gone = pub.notReadyMessage({ disclosureAccepted: 1, disconnected: true });
  assert.equal(gone.action.label, 'Reconnect');
  assert.match(gone.message, /Press Reconnect/);
});

test('D4: onboarding stays on the publik step with the reason and "Try again" when the mint fails', () => {
  const step = rendererSrc.slice(rendererSrc.indexOf('function publikStep()'), rendererSrc.indexOf('function publikCardStep()'));
  assert.match(step, /if \(!publikState\.connected \|\| publikState\.revoked\) \{\n\s+obPublikError = publikState\.problem \|\| 'Setup did not finish\.';\n\s+step\.buttons\[0\]\.label = 'Try again';\n\s+renderOnboard\(\);\n\s+return;/);
  assert.match(step, /error: \(\) => \(obPublikError \? `<strong>Setup did not finish\.<\/strong> \$\{esc\(obPublikError\)\}` : ''\),/);
  // Shown outside the scrolling text, so it is always in view.
  assert.match(html, /<div class="ob-body" id="ob-body"><\/div>\s*<!--[^>]*-->\s*<div class="ob-error hidden" id="ob-error" role="alert"><\/div>\s*<div class="ob-buttons" id="ob-buttons"><\/div>/);
  assert.match(fnSrc('renderOnboard'), /\$\('#ob-error'\)\.classList\.toggle\('hidden', !stepError\);/);
  // The failure return comes before any move to the next step.
  assert.ok(step.indexOf("label = 'Try again'") < step.indexOf('obIndex++'));
});

test('D5: common failures read in plain words, with the real wait from Retry-After', () => {
  const now = Date.parse('2026-11-02T08:00:00Z');
  assert.equal(pub.failureKind(Object.assign(new TypeError('fetch failed'), {})), 'network');
  assert.equal(pub.failureKind({ name: 'AbortError', message: 'This operation was aborted' }), 'network');
  assert.equal(pub.failureKind({ status: 429, type: 'rate_limited' }), 'rate');
  assert.equal(pub.failureKind({ status: 503 }), 'server');
  assert.equal(pub.failureKind({ status: 401 }), 'http');
  assert.deepEqual(pub.failureFields({ status: 429, retryAfter: 2460 }, now), { lastErrorKind: 'rate', lastErrorStatus: 429, lastErrorRetryAt: now + 2460000 });
  assert.equal(pub.plainProblem({ lastError: 'fetch failed', lastErrorKind: 'network' }, now), 'cue could not reach publik. Check your internet connection, then try again.');
  assert.equal(pub.plainProblem({ lastError: 'Too many provisioning requests from this network.', lastErrorKind: 'rate', lastErrorRetryAt: now + 2460000 }, now),
    'publik is limiting new setups from this network. Try again in 41 minutes.');
  assert.equal(pub.plainProblem({ lastError: 'x', lastErrorKind: 'rate', lastErrorRetryAt: 0 }, now), 'publik is limiting new setups from this network. Try again in a few minutes.');
  assert.match(pub.plainProblem({ lastError: 'upstream 502', lastErrorKind: 'server' }, now), /^publik had a problem on its side\. Nothing was charged\./);
  for (const kind of ['network', 'rate', 'server', 'http']) {
    assert.doesNotMatch(pub.plainProblem({ lastError: 'fetch failed', lastErrorKind: kind, lastErrorStatus: 400 }, now), /fetch failed/);
  }
  // The card shows the plain sentence, never the raw one.
  const v = card.cardView({ ...BASE, disclosureAccepted: 1, lastError: 'fetch failed', problem: 'cue could not reach publik. Check your internet connection, then try again.', status: { text: 'fetch failed', warn: true } }, 'publik');
  assert.equal(v.status, 'cue could not reach publik. Check your internet connection, then try again.');
  assert.deepEqual(v.primary, { kind: 'reconnect', label: 'Reconnect' });
  // main.js hands the plain sentence to the renderer.
  assert.match(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), /problem: publik\.plainProblem\(p\),/);
});

test('D5: a refused mint records the kind and the Retry-After wait (main.js publikProvision stores failureFields)', () => {
  const e = Object.assign(new Error('Too many provisioning requests from this network.'), { status: 429, type: 'rate_limited', retryAfter: 2460 });
  const p = { lastError: e.message, ...pub.failureFields(e) };
  assert.equal(p.lastErrorKind, 'rate');
  assert.ok(p.lastErrorRetryAt > Date.now() + 2400000);
  assert.match(pub.plainProblem(p), /Try again in 41 minutes\./);
  // A sentence from the module (no app token, a gateway refusal) is shown as it is.
  assert.equal(pub.plainProblem({ lastError: 'This app token is not valid.', lastErrorKind: 'gateway' }), 'This app token is not valid.');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /lastErrorKind: 'gateway'/);
});

test('D7: the example conversation never sits under the sign-in prompt', () => {
  assert.match(fnSrc('showExample'), /classList\.add\('is-example'\)/);
  const cta = fnSrc('renderSetupCta');
  assert.match(cta, /messages\.querySelectorAll\('\.is-example'\)\.forEach\(\(node\) => node\.remove\(\)\);/);
  assert.match(cta, /if \(el\) \{ el\.remove\(\); if \(!messages\.children\.length\) showExample\(\); \}/);
});

test('D8: right after linking with only the $0.05 starter: a neutral welcome and "Pick a plan"', () => {
  const starterOnly = {
    ...LINKED, balanceMicros: 50000, line: 'Linked to your publik account · $0.05 left',
    wallet: { claimState: 'claimed', balanceMicros: 50000, planId: 'none', packRemainingMicros: 0, starterRemainingMicros: 50000, plansUrl: 'https://publikhq.com/developers#plans' },
    settingsCta: { label: 'Pick a plan', url: 'https://publikhq.com/dashboard/api' }
  };
  const v = card.cardView(starterOnly, 'publik');
  assert.equal(v.warn, false);
  assert.equal(v.status, 'Linked. $0.05 to try cue.');
  assert.deepEqual(v.primary, { kind: 'plan', label: 'Pick a plan', url: 'https://publikhq.com/developers#plans' });
  // Partly used starter: still a welcome.
  assert.equal(card.cardView({ ...starterOnly, balanceMicros: 31000, wallet: { ...starterOnly.wallet, balanceMicros: 31000, starterRemainingMicros: 31000 } }, 'publik').status, 'Linked. $0.03 to try cue.');
  // Free money gone, nothing paid: neutral, still "Pick a plan".
  const zero = card.cardView({ ...starterOnly, balanceMicros: 0, wallet: { ...starterOnly.wallet, balanceMicros: 0, starterRemainingMicros: 0 } }, 'publik');
  assert.equal(zero.warn, false);
  assert.equal(zero.primary.label, 'Pick a plan');
  // Paid money running low keeps the warning: a plan, or pack money left.
  const plan = card.cardView({ ...starterOnly, wallet: { ...starterOnly.wallet, planId: 'basic' } }, 'publik');
  assert.equal(plan.warn, true);
  assert.equal(plan.status, 'Low balance · $0.05 left.');
  assert.equal(plan.primary.label, 'Add a plan or pack');
  const pack = card.cardView({ ...starterOnly, balanceMicros: 120000, wallet: { ...starterOnly.wallet, balanceMicros: 120000, packRemainingMicros: 70000 } }, 'publik');
  assert.equal(pack.warn, true);
  // More than the starter left with no plan (other money): not "to try".
  assert.equal(card.onlyFreeMoney({ wallet: { planId: 'none', packRemainingMicros: 0, starterRemainingMicros: 0 } }, 69150000), false);
  // The wallet's pack field reaches the renderer.
  assert.equal(pub.normalizeWallet({ claim_state: 'claimed', balance_micros: 50000, pack: { remaining_micros: 0 }, starter: { remaining_micros: 50000 }, plan: { id: 'none' } }).packRemainingMicros, 0);
  // openPublikLink = publikOpen + startLinkPoll (0.2.10).
  assert.match(fnSrc('onPublikPrimary'), /primary\.kind === 'credit' \|\| primary\.kind === 'plan'\) openPublikLink\(primary\.url\);/);
  assert.match(rendererSrc, /function openPublikLink\(url\) \{\n    cue\.publikOpen\(url\);\n    startLinkPoll\(\);\n  \}/);
});

test('D9: the onboarding dialog never grows past the 600 px window', () => {
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /#onboard \{[^}]*max-height: calc\(100vh - 16px\); box-sizing: border-box; display: flex; flex-direction: column; \}/);
  assert.match(css, /#onboard > \.ob-body \{ flex: 0 1 auto; min-height: 0; overflow-y: auto; \}/);
});

// After the 0.2.7 rebase: the toast after a Reconnect press (renderer
// showReconnectResult) reads p.status.text, so the status line must be plain
// words too, never the raw "fetch failed".
test('D5 + 0.2.7: statusLine says a failed Reconnect in plain words, gateway sentences pass through', () => {
  const pub = require('../src/publik-ui');
  const failed = pub.statusLine({ connected: true, revoked: true, disclosureAccepted: true, lastError: 'fetch failed', lastErrorKind: 'network' });
  assert.equal(failed.warn, true);
  assert.match(failed.text, /^cue could not reach publik\./);
  assert.doesNotMatch(failed.text, /fetch failed/);
  const notSet = pub.statusLine({ connected: false, disclosureAccepted: true, lastError: 'fetch failed', lastErrorKind: 'network' });
  assert.match(notSet.text, /^cue could not reach publik\./);
  const gateway = 'publik API is disconnected. This computer was removed from your publik account.';
  assert.equal(pub.statusLine({ connected: true, revoked: true, lastError: gateway }).text, gateway);
});

// Live check after the 0.2.7 rebase: a Reconnect press that cannot reach
// publik sets `revoked` (main.js publikReconnect) and then fails the mint.
// The overlay, the ask message and the toast must still name the failure.
test('0.2.7 Reconnect that fails: every place says the failure in plain words, not "disconnected"', () => {
  const pub = require('../src/publik-ui');
  const card = require('../renderer/publik-card');
  const problem = 'cue could not reach publik. Check your internet connection, then try again.';
  const view = { available: true, connected: false, revoked: true, disclosureAccepted: 1, lastError: 'fetch failed', problem, setupFailed: true };
  const prompt = card.setupPrompt({ provider: 'publik', apiKeys: {} }, view);
  assert.equal(prompt.title, 'Setup did not finish');
  assert.equal(prompt.body, problem);
  assert.equal(prompt.primary.label, 'Reconnect');
  assert.equal(pub.notReadyMessage(view).message, `Setup did not finish. ${problem}`);
  assert.equal(pub.statusLine(view).text, problem);
  assert.equal(card.cardView(view, 'publik').status, problem);
  // A dashboard revoke (a gateway sentence, no failed setup) still reads as disconnected.
  const revoked = { available: true, connected: false, revoked: true, disclosureAccepted: 1, lastError: 'publik API is disconnected. This computer was removed from your publik account.', problem: 'publik API is disconnected. This computer was removed from your publik account.', setupFailed: false };
  assert.equal(card.setupPrompt({ provider: 'publik', apiKeys: {} }, revoked).title, 'publik is disconnected');
  assert.match(pub.notReadyMessage(revoked).message, /^publik is disconnected on this computer/);
  // main.js hands the flag over in its view.
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /setupFailed: !!\(p\.lastError && p\.lastErrorKind\),/);
});
