const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// af29ec5 deleted both `#provider-publik` toggles from renderer.js while
// index.html still ships the button with class "hidden". Settings then never
// showed "publik API", and a user who had picked their own key (every 0.2.4
// Mac settings file with provider=openai) had no way back to publik.

const root = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

function fnBody(name) {
  const start = rendererSrc.indexOf(`function ${name}()`);
  assert.ok(start > -1, `${name} not found in renderer.js`);
  const end = rendererSrc.indexOf('\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return rendererSrc.slice(start, end + 4);
}

function fakeElement() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    classList: {
      toggle(name, on) { if (on === undefined) on = !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

// Runs the real renderPublikBlock source against fake elements.
function renderWith(publikState, settings) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, fakeElement()); return els.get(id); };
  const ctx = vm.createContext({ $, publikState, settings, statusText: () => 'status' });
  vm.runInContext(`${fnBody('renderPublikBlock')}\nrenderPublikBlock();`, ctx);
  return $;
}

const STATE = {
  available: true, connected: false, revoked: false, disclosureAccepted: 0, claimState: 'anonymous',
  copy: { cost: 'c', dataPath: 'd', whyItCostsToggle: 'w', whyItCosts: 'ww' },
  status: { text: 'Not set up yet — no key needed to set it up.', warn: false },
  settingsCta: null, lowStarter: null, addCreditUrl: ''
};

test('index.html ships the publik API picker button hidden, so the renderer must reveal it', () => {
  assert.match(html, /<button data-provider="publik" id="provider-publik" class="hidden">/);
});

test('a 0.2.4 settings file with provider=openai still gets the publik API button in a token build', () => {
  const $ = renderWith(STATE, { provider: 'openai', apiKeys: { openai: 'sk-test' } });
  assert.equal($('#provider-publik').classList.contains('hidden'), false, 'publik API button must be visible');
  // The card itself follows the selected provider (updateCustomProviderFields);
  // its set-up button is ready for the moment the user picks publik.
  assert.equal($('#publik-setup').classList.contains('hidden'), false);
});

test('a build with no app token keeps the publik API button hidden', () => {
  const $ = renderWith({ ...STATE, available: false }, { provider: 'openai', apiKeys: { openai: 'sk-test' } });
  assert.equal($('#provider-publik').classList.contains('hidden'), true);
});

test('boot reveals the publik API button before Settings or onboarding render', () => {
  const start = rendererSrc.indexOf('(async function boot()');
  assert.ok(start > -1, 'boot not found');
  const boot = rendererSrc.slice(start, start + 1500);
  const toggle = boot.indexOf("$('#provider-publik').classList.toggle('hidden', !publikState.available)");
  assert.ok(toggle > -1, 'boot must toggle #provider-publik on publikState.available');
  assert.ok(toggle > boot.indexOf('publikState = await cue.publikState()'), 'toggle runs after publikState is loaded');
});

test('picking publik API in Settings shows the publik card', () => {
  assert.match(fnBody('updateCustomProviderFields'), /\$\('#publik-settings'\)\.classList\.toggle\('hidden', provider !== 'publik'\)/);
  assert.match(rendererSrc, /document\.querySelectorAll\('#provider-seg button'\)\.forEach\(\(b\) => b\.addEventListener\('click', \(\) => \{\n    settings\.provider = b\.dataset\.provider;/);
});
