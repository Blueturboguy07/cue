const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deferred } = require('./helpers/main-harness');
const source = fs.readFileSync(path.join(__dirname, '../renderer/privacy.js'), 'utf8');

function harness(permissions = false) {
  const pending = deferred(), events = new Map(), ready = [], actions = [];
  function element() {
    return { textContent: '', handlers: new Map(), children: [], addEventListener(name, fn) { this.handlers.set(name, fn); }, appendChild(child) { this.children.push(child); } };
  }
  const elements = { 'privacy-notice': element() };
  if (!permissions) { elements['window-hide-btn'] = element(); elements['pause-btn'] = element(); }
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] || null, createElement: () => element() },
    window: { cue: {
      on: (name, fn) => events.set(name, fn), privacyState: () => pending.promise,
      windowReady: (token) => ready.push({ token, notice: elements['privacy-notice'].textContent }),
      privacyPause: async () => actions.push('pause'), privacyResume: async () => actions.push('resume'),
      hideWindow: async () => actions.push('hide'),
    } },
  });
  return { pending, events, ready, actions, elements };
}
function state(extra = {}) { return { paused: false, recoverable: true, windowToken: 7, protection: { status: 'requested', verified: false }, ...extra }; }

test('the protection notice is set before acknowledging window readiness', async () => {
  const h = harness();
  assert.equal(h.ready.length, 0);
  h.pending.resolve(state());
  await new Promise(setImmediate);
  assert.equal(h.ready[0].token, 7);
  assert.match(h.ready[0].notice, /receiver visibility is unverified/);
});

test('debug bypass and unsupported protection remain explicit in the notice', async () => {
  const h = harness();
  h.pending.resolve(state({ protection: { status: 'disabled', reason: 'debug-override' } }));
  await new Promise(setImmediate);
  assert.match(h.elements['privacy-notice'].textContent, /disabled by CUE_NO_PROTECT/);
  h.events.get('privacy:state')(state({ protection: { status: 'unsupported', reason: 'linux' } }));
  assert.match(h.elements['privacy-notice'].textContent, /unsupported on Linux/);
});

test('an old initialization response cannot overwrite pause or change Resume into Pause', async () => {
  const h = harness();
  h.events.get('privacy:state')(state({ paused: true }));
  h.pending.resolve(state());
  await new Promise(setImmediate);
  assert.match(h.elements['privacy-notice'].textContent, /Privacy pause is active/);
  assert.equal(h.elements['pause-btn'].textContent, 'Resume');
  await h.elements['pause-btn'].handlers.get('click')();
  assert.deepEqual(h.actions, ['resume']);
});

test('permission UI can explicitly resume, and failed recovery disables Hide', async () => {
  const h = harness(true);
  h.pending.resolve(state({ paused: true, recoverable: false }));
  await new Promise(setImmediate);
  assert.match(h.elements['privacy-notice'].textContent, /Cue stays visible/);
  await h.elements['privacy-notice'].children[0].handlers.get('click')();
  assert.deepEqual(h.actions, ['resume']);
  const main = harness();
  main.pending.resolve(state({ recoverable: false }));
  await new Promise(setImmediate);
  assert.equal(main.elements['window-hide-btn'].disabled, true);
});
