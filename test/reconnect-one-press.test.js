// 0.2.10, from the v0.2.9 smoke test: a revoked user who asks a question
// first gets a Reconnect button inside the message. That button made a new
// key and stopped there: no claim page, no link poll, so the person had to
// press "Link this computer & pick a plan" too, and after the sign-in cue
// kept saying "Finish signing in / $0.00 left" until the next answer. The
// overlay Reconnect at startup already did all three in one press.
// These tests run the real renderer functions in a vm with a fake `cue`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const card = require('../renderer/publik-card');

function fnFrom(src, head) {
  const start = src.indexOf(head);
  assert.ok(start > -1, `${head} not found`);
  const indent = head.match(/^\s*/)[0];
  const end = src.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > -1, `end of ${head} not found`);
  return src.slice(start, end + indent.length + 3);
}

// The publik action buttons, the claim link, the Reconnect path and the link
// poll: one block of renderer.js, from publikActionButton to signInWithPublik.
function publikBlock() {
  const start = rendererSrc.indexOf('  function publikActionButton(action, secondary) {');
  const end = rendererSrc.indexOf('  // "Sign in with publik": consent first');
  assert.ok(start > -1 && end > start, 'publik block not found');
  return rendererSrc.slice(start, end);
}

const CLAIM = 'https://publikhq.com/claim/ABCD-EFGH';
const REVOKED = { available: true, connected: true, revoked: true, disconnected: true, disclosureAccepted: 1, keyId: 'oldkey', claimState: 'claimed', claimUrl: '', wallet: { claimState: 'claimed', balanceMicros: 4200000 } };
const MINTED = {
  available: true, connected: true, revoked: false, disconnected: false, disclosureAccepted: 1, keyId: 'newkey',
  claimState: 'anonymous', claimUrl: CLAIM, balanceMicros: 0, wallet: { claimState: 'anonymous', balanceMicros: 0 },
  line: 'Ready · $0.00 left', settingsCta: { label: 'Link this computer & pick a plan', url: CLAIM }
};
const LINKED = {
  ...MINTED, claimState: 'claimed', claimUrl: '', balanceMicros: 4200000,
  wallet: { claimState: 'claimed', balanceMicros: 4200000, planId: 'basic' },
  line: 'Linked to your publik account · $4.20 left', settingsCta: { label: 'Manage plan', url: 'https://publikhq.com/dashboard/api' }
};
const FAILED = {
  available: true, connected: false, revoked: true, disconnected: true, disclosureAccepted: 1, keyId: '', claimState: 'anonymous',
  lastError: 'fetch failed', setupFailed: true, problem: 'cue could not reach publik. Check the internet connection and press Reconnect.',
  status: { text: 'cue could not reach publik. Check the internet connection and press Reconnect.', warn: true }
};

function element() {
  return {
    dataset: {}, textContent: '', disabled: false, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
}

function harness({ start, reconnectTo, refreshTo = [], extra = '' }) {
  const calls = { reconnect: 0, open: [], refresh: 0, cardSeen: 0, status: [], cta: 0 };
  const timers = [];
  const queue = [...refreshTo];
  const ctx = vm.createContext({
    window: { cuePublikCard: card },
    document: { createElement: () => element(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    $: () => element(),
    cue: {
      publikReconnect: async () => { calls.reconnect++; return reconnectTo; },
      publikOpen: (url) => { calls.open.push(url); },
      publikCardSeen: async () => { calls.cardSeen++; return { ...ctx.publikState, cardShown: true }; },
      publikRefresh: async () => { calls.refresh++; return queue.length ? queue.shift() : ctx.publikState; },
      settingsGet: async () => ({})
    },
    settings: { provider: 'publik', apiKeys: {}, models: {} },
    publikState: start,
    renderPublikBlock: () => {},
    renderSetupCta: () => { calls.cta++; },
    showStatus: (message, button) => {
      calls.status.push({ message, kinds: [].concat(button || []).filter(Boolean).map((b) => b.dataset.kind) });
    },
    setInterval: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearInterval: (id) => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    Date, Promise
  });
  vm.runInContext(`${publikBlock()}\n${extra}\nthis.publikActionButton = publikActionButton;`, ctx);
  const live = () => timers.filter((t) => t.live);
  // One 4 s tick of every running poll.
  const tick = async () => { for (const t of live()) await t.fn(); };
  return { ctx, calls, live, tick };
}

async function press(h, action) {
  const btn = h.ctx.publikActionButton(action);
  assert.ok(btn, `no button for ${action.kind}`);
  await btn.listeners.click();
  return btn;
}

test('in-message Reconnect: one press makes the key, opens the claim page and starts the link poll', async () => {
  const h = harness({ start: REVOKED, reconnectTo: MINTED });
  await press(h, { kind: 'reconnect', label: 'Reconnect' });
  assert.equal(h.calls.reconnect, 1, 'one new key');
  assert.deepEqual(h.calls.open, [CLAIM], 'the claim page opens with no second button');
  assert.equal(h.live().length, 1, 'cue watches the wallet');
  assert.equal(h.live()[0].ms, 4000);
  // No "connected again · [Link this computer & pick a plan]" toast that asks for a second press.
  assert.deepEqual(h.calls.status, []);
  assert.ok(h.calls.cta > 0, 'the overlay prompt and the old toast follow the new state');
});

test('in-message Reconnect: the line says "Linked … $4.20 left" as soon as the claim lands, with no new answer', async () => {
  const h = harness({ start: REVOKED, reconnectTo: MINTED, refreshTo: [MINTED, LINKED] });
  await press(h, { kind: 'reconnect', label: 'Reconnect' });
  await h.tick(); // not signed in yet: nothing to say
  assert.deepEqual(h.calls.status, []);
  assert.equal(h.ctx.publikState.claimState, 'anonymous');
  assert.equal(card.setupPrompt(h.ctx.settings, h.ctx.publikState).title, 'Finish signing in');
  await h.tick(); // the sign-in landed on publikhq.com
  assert.equal(h.ctx.publikState.claimState, 'claimed');
  assert.deepEqual(h.calls.status, [{ message: 'Linked to your publik account · $4.20 left.', kinds: [] }]);
  assert.equal(card.cardView(h.ctx.publikState, 'publik').status, 'Linked to your publik account · $4.20 left');
  assert.equal(card.setupPrompt(h.ctx.settings, h.ctx.publikState), null, '"Finish signing in" is gone');
  await h.tick(); // the poll ends once linked
  assert.equal(h.calls.refresh, 2);
  assert.equal(h.live().length, 0);
});

test('in-message Reconnect on a key that is still linked: no claim page, the toast says it is connected again', async () => {
  const h = harness({ start: REVOKED, reconnectTo: LINKED });
  await press(h, { kind: 'reconnect', label: 'Reconnect' });
  assert.deepEqual(h.calls.open, []);
  assert.equal(h.live().length, 0);
  assert.equal(h.calls.status.length, 1);
  assert.match(h.calls.status[0].message, /^publik API is connected again · key newkey\.$/);
});

test('in-message Reconnect that cannot mint: the plain reason and "Try again", no claim page', async () => {
  const h = harness({ start: REVOKED, reconnectTo: FAILED });
  await press(h, { kind: 'reconnect', label: 'Reconnect' });
  assert.deepEqual(h.calls.open, []);
  assert.equal(h.live().length, 0);
  assert.deepEqual(h.calls.status, [{ message: FAILED.status.text, kinds: ['reconnect'] }]);
});

test('a toast link to publikhq.com ("Link this computer & pick a plan", "Link now") starts the link poll too', async () => {
  const h = harness({ start: MINTED, reconnectTo: null, refreshTo: [LINKED] });
  await press(h, { kind: 'link', label: 'Link this computer & pick a plan', url: CLAIM });
  assert.deepEqual(h.calls.open, [CLAIM]);
  assert.equal(h.live().length, 1);
  await h.tick();
  assert.deepEqual(h.calls.status, [{ message: 'Linked to your publik account · $4.20 left.', kinds: [] }]);
});

test('the first-run card\'s "Link this computer" button watches for the claim', async () => {
  const start = { ...MINTED, card: { title: 'publik API is set up', balance: '$0.00', why: 'why', primary: { label: 'Link this computer & pick a plan', url: CLAIM }, secondary: { label: 'Later' } } };
  const h = harness({
    start, reconnectTo: null, refreshTo: [LINKED],
    extra: `var OB_STEPS = []; var obDialog = true; var obIndex = 0; function hideOnboardDialog() {} function finishOnboard() {} function renderOnboard() {}\n${fnFrom(rendererSrc, '  function publikCardStep() {')}\nthis.publikCardStep = publikCardStep;`
  });
  const step = h.ctx.publikCardStep();
  await step.buttons[0].action();
  assert.deepEqual(h.calls.open, [CLAIM]);
  assert.equal(h.live().length, 1);
  await h.tick();
  assert.equal(h.ctx.publikState.claimState, 'claimed');
  assert.equal(h.calls.status.length, 1);
});

test('the overlay and Settings Reconnect still open the claim page and poll (one shared path)', async () => {
  const extra = `function signInWithPublik() {} function switchToPublik() {} function openSettings() {} function selectByoProvider() {} function fixOwnKey() {}\n` +
    `${fnFrom(rendererSrc, '  async function runSetupAction(kind) {')}\n${fnFrom(rendererSrc, '  async function onPublikPrimary() {')}\n` +
    'this.runSetupAction = runSetupAction; this.onPublikPrimary = onPublikPrimary;';
  const overlay = harness({ start: REVOKED, reconnectTo: MINTED, extra });
  await overlay.ctx.runSetupAction('reconnect');
  assert.deepEqual(overlay.calls.open, [CLAIM]);
  assert.equal(overlay.live().length, 1);
  const settingsCard = harness({ start: REVOKED, reconnectTo: MINTED, extra });
  await settingsCard.ctx.onPublikPrimary();
  assert.deepEqual(settingsCard.calls.open, [CLAIM]);
  assert.equal(settingsCard.live().length, 1);
  // Only reconnectPublik and the sign-in call publikReconnect: no button keeps its own copy.
  assert.equal(rendererSrc.split('cue.publikReconnect()').length - 1, 2);
  assert.match(fnFrom(rendererSrc, '  async function runSetupAction(kind) {'), /kind === 'reconnect'\) await reconnectPublik\(\);/);
  assert.match(fnFrom(rendererSrc, '  async function onPublikPrimary() {'), /primary\.kind === 'reconnect'\) await reconnectPublik\(\);/);
});

test('no claim link opens without the poll: every publikOpen of a claim or top-up link goes through openPublikLink or openClaimLink', () => {
  const opens = rendererSrc.split('\n').filter((line) => line.includes('cue.publikOpen('));
  const allowed = [
    /function openPublikLink|^\s+cue\.publikOpen\(url\);$/, // openPublikLink itself
    /cue\.publikOpen\(view\.primary\.url\);/, // openClaimLink
    /v\.manage\.url/, // "Manage plan": already linked
    /v\.credit\.url\); startLinkPoll\(\);/, // "Add a plan or pack"
    /links\.pricing|links\.terms/ // help pages
  ];
  for (const line of opens) assert.ok(allowed.some((re) => re.test(line)), `publikOpen with no link poll: ${line.trim()}`);
});
