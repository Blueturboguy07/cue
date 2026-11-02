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
  const failed = card.setupPrompt(settings, { ...BASE, disclosureAccepted: 1, lastError: 'Too many provisioning requests from this network.' });
  assert.equal(failed.title, 'cue could not connect to publik');
  assert.equal(failed.body, 'Too many provisioning requests from this network.');
  assert.equal(failed.primary.label, 'Reconnect');
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
  assert.match(main, /publikBuild\.available\n\s+\? \{ message: `\$\{message\} Or switch to publik: cue then runs on your publik balance and needs no API key\.`, action: \{ kind: 'switch' \} \}/);
  assert.doesNotMatch(main, /No transcription key set/);
  assert.match(main, /Transcription is off\. Switch to publik in Settings to transcribe with no API key\./);
  assert.match(main, /Pick Local in Settings › Audio to transcribe on this computer with no key/);
  const pub = require('../src/publik');
  assert.equal(pub.COPY.disclosure.accept, 'Sign in with publik');
  assert.match(fnSrc('publikActionButton'), /'disclosure'\) \{\n\s+btn\.textContent = 'Sign in with publik';/);
  assert.match(fnSrc('publikActionButton'), /'switch'\) \{\n\s+btn\.textContent = 'Switch to publik';/);
  assert.doesNotMatch(rendererSrc, /cue uses API keys for/);
});

test('index.html loads publik-card.js before renderer.js (same file on Windows and Mac)', () => {
  assert.ok(html.indexOf('<script src="publik-card.js"></script>') > -1);
  assert.ok(html.indexOf('publik-card.js') < html.indexOf('renderer.js'));
});
