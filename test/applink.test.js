const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const { describeState, consentCopy } = require('../src/applink-state');
const { AppLinkServer, AppLinkClient, ERROR_CODES } = require('../vendor/app-link');

const originalModuleLoad = Module._load;

// src/applink.js requires electron directly (app/dialog/ipcMain), so it can
// only be loaded under a real Electron process — except here, where a thin
// stub lets the get_slides consent-gating logic (below) run end to end over
// a real socket, the same way the rest of this file already does.
function loadAppLink({ dialogResponse } = {}) {
  const dialogCalls = [];
  const stubIpcMain = { on() {}, removeListener() {}, handle() {}, handleOnce() {} };
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', focus: () => {} },
        dialog: {
          showMessageBox: async (opts) => {
            dialogCalls.push(opts);
            return { response: dialogResponse === undefined ? 0 : dialogResponse };
          }
        },
        ipcMain: stubIpcMain
      };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/applink');
  delete require.cache[id];
  const applink = require('../src/applink');
  Module._load = originalModuleLoad;
  return { applink, dialogCalls };
}

const SETTINGS = {
  provider: 'openai',
  smart: true,
  resumeContext: 'Mann Bellani — Texas A&M, worked at …',
  apiKeys: { openai: 'sk-proj-realkeyvaluehere', anthropic: '', gemini: 'AIzaSyRealKey', nvidia: '' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } },
};

const TRANSCRIPT = [
  { channel: 'them', text: 'So what salary were you expecting?', ts: 1754300000000 },
  { channel: 'you', text: 'I was hoping for something around…', ts: 1754300005000 },
];

function snapshot(overrides = {}) {
  return {
    state: { capturing: true, busy: false, transcribing: { you: false, them: true } },
    transcript: TRANSCRIPT,
    settings: SETTINGS,
    sttDisabled: false,
    shortcuts: { assist: 'CommandOrControl+Return', leetcode: true, quit: true },
    windowAlive: true,
    ...overrides,
  };
}

test('reports what cue is doing', () => {
  const state = describeState(snapshot());
  assert.equal(state.capturing, true);
  assert.equal(state.transcribing.them, true);
  assert.equal(state.transcriptTurns, 2);
  assert.equal(state.lastTurnAt, new Date(1754300005000).toISOString());
  assert.equal(state.provider, 'openai');
  assert.deepEqual(state.models, { fast: 'gpt-4o-mini', smart: 'gpt-4o' });
  assert.deepEqual(state.shortcuts, { assist: 'CommandOrControl+Return', leetcode: true, quit: true });
});

/**
 * The one test in this file that matters more than the others. cue's transcript
 * is a recording of people who never agreed to share it, and the résumé and the
 * keys are the user's. If any of them ever appear in this object they are one
 * `capture_diagnostics` away from a bug report.
 */
test('never exposes transcript text, résumé or API keys', () => {
  const serialized = JSON.stringify(describeState(snapshot()));
  assert.ok(!serialized.includes('salary'), 'transcript text leaked');
  assert.ok(!serialized.includes('hoping for something'), 'transcript text leaked');
  assert.ok(!serialized.includes('Texas A&M'), 'résumé leaked');
  assert.ok(!serialized.includes('sk-proj-'), 'OpenAI key leaked');
  assert.ok(!serialized.includes('AIzaSy'), 'Gemini key leaked');
});

test('reports which keys are set without reporting them', () => {
  const state = describeState(snapshot());
  assert.deepEqual(state.hasKey, { openai: true, anthropic: false, gemini: true, nvidia: false });
  assert.equal(state.hasResumeContext, true);
});

test('surfaces transcription being silently dead', () => {
  assert.equal(describeState(snapshot({ sttDisabled: true })).transcriptionDisabled, true);
});

test('handles an empty session without inventing a timestamp', () => {
  const state = describeState(snapshot({ transcript: [] }));
  assert.equal(state.transcriptTurns, 0);
  assert.equal(state.lastTurnAt, null);
});

test('hedges the consent sheet when the caller cannot be verified', () => {
  const unverified = consentCopy({ callerName: 'Iris', scope: 'read', verification: 'token' });
  assert.match(unverified.message, /identifying itself as/);
  assert.match(unverified.detail, /cannot verify/);
  assert.equal(unverified.trusted, false);

  const verified = consentCopy({ callerName: 'Iris', scope: 'read', verification: 'code-signature' });
  assert.equal(verified.message, 'Iris wants to see what cue is doing.');
  assert.match(verified.detail, /signature has been verified/);
});

test('asks separately, and differently, for control', () => {
  const copy = consentCopy({ callerName: 'Iris', scope: 'action', verification: 'token' });
  assert.match(copy.message, /wants to control cue/);
  assert.equal(copy.allowLabel, 'Allow control');
});

/**
 * get_slides reuses the link's 'action' scope for authorization (only two
 * scopes exist in vendor/app-link), but must never present it as an
 * unqualified "control cue" grant covering slide captions too — a caller
 * already trusted to start/stop listening is not automatically trusted to
 * read what cue captioned off the user's screen. This is the copy shown for
 * that separate, additional prompt (see src/applink.js's get_slides handler).
 */
test('asks separately, and differently, for slide captions — never folded into the control prompt', () => {
  const copy = consentCopy({ callerName: 'Iris', scope: 'slides', verification: 'none' });
  assert.match(copy.message, /slide captions/);
  assert.doesNotMatch(copy.message, /control cue/);
  assert.match(copy.detail, /caption/i);
  assert.match(copy.detail, /screen/i);
  // Reassures rather than overstates: captions only, never a screenshot.
  assert.match(copy.detail, /never a screenshot/i);
});

/**
 * End to end over a real socket, without Electron: discovery, consent, and the
 * three questions Iris actually asks when someone says cue is broken.
 */
test('answers Iris over the link', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-applink-'));
  const pathOptions = { homedir: home, env: { ...process.env, LOCALAPPDATA: path.join(home, 'Local') } };

  let asked = 0;
  const link = new AppLinkServer({
    appId: 'com.cue.overlay',
    appSlug: 'cue',
    appName: 'cue',
    appVersion: '0.2.1',
    pathOptions,
    stateProvider: () => describeState(snapshot({ sttDisabled: true })),
    onConsentRequest: () => { asked += 1; return true; },
  });
  await link.start();
  t.after(() => link.stop());

  link.record({ level: 'error', event: 'stt_rejected', code: 'http_403', msg: 'no access to a speech model', frame: 'handleSttError' });

  const found = AppLinkClient.discover(pathOptions).find((entry) => entry.appId === 'com.cue.overlay');
  assert.ok(found, 'cue did not announce itself');

  const client = await AppLinkClient.open(found, { client: { id: 'com.publikhq.iris', name: 'Iris' }, scopes: ['read'] });
  t.after(() => client.close());

  assert.equal(asked, 1);

  const { state } = await client.getState();
  assert.equal(state.transcriptionDisabled, true);
  assert.equal(state.capturing, true);

  const { event } = await client.getLastError();
  assert.equal(event.code, 'http_403');
  assert.equal(event.frame, 'handleSttError');

  const bundle = await client.captureDiagnostics();
  assert.equal(bundle.app.slug, 'cue');
  assert.equal(bundle.lastError.msg, 'no access to a speech model');
  // Same guarantee as above, now through the wire rather than the function.
  const wire = JSON.stringify(bundle);
  assert.ok(!wire.includes('salary') && !wire.includes('sk-proj-'), 'diagnostics bundle leaked private data');
});

/**
 * get_slides sits behind the link's 'action' scope (the same one that gates
 * set_capturing — there is no third scope in vendor/app-link, see
 * consentCopy's comment above), but that grant alone must not be enough: a
 * caller who only ever agreed to "start and stop listening" should not be
 * able to silently start reading slide captions the moment this feature is
 * turned on. This drives src/applink.js's REAL registered get_slides
 * handler directly (captured off a patched AppLinkServer.action/start, so
 * this needs no real socket, disk path, or Electron app), confirming it
 * prompts on its own before ever returning caption text.
 */
test('get_slides prompts separately for consent even though the caller already holds the action scope', async () => {
  const AppLink = require('../vendor/app-link');
  const originalAction = AppLink.AppLinkServer.prototype.action;
  const originalStart = AppLink.AppLinkServer.prototype.start;
  const actions = new Map();
  AppLink.AppLinkServer.prototype.action = function (name, def) { actions.set(name, def); };
  AppLink.AppLinkServer.prototype.start = async function () {};

  const slidesConsent = {};
  const slides = [{ text: 'Q3 roadmap', ts: 1 }, { text: 'Pricing', ts: 2 }];
  const { applink, dialogCalls: calls } = loadAppLink({ dialogResponse: 1 }); // 1 = Allow

  try {
    applink.startAppLink({
      snapshot: () => snapshot({ slides }),
      setCapturing: () => {},
      getSlides: () => slides,
      getSlidesConsent: (id) => slidesConsent[id],
      setSlidesConsent: (id, decision) => { slidesConsent[id] = decision; },
      getWindow: () => null // forces the dialog.showMessageBox fallback path
    });

    const getSlides = actions.get('get_slides');
    assert.ok(getSlides, 'get_slides was registered');
    assert.equal(calls.length, 0, 'no prompt yet — nothing has asked for slides');

    const caller = { id: 'com.publikhq.iris', name: 'Iris' };
    const first = await getSlides.handler({}, { caller });
    assert.equal(calls.length, 1, 'the first get_slides call prompts once');
    assert.match(calls[0].message, /slide captions/);
    assert.equal(first.count, 2);
    assert.deepEqual(first.slides, slides);
    assert.equal(slidesConsent['com.publikhq.iris'], 'granted');

    await getSlides.handler({}, { caller });
    assert.equal(calls.length, 1, 'a second call does not re-prompt — the decision is remembered');
  } finally {
    AppLink.AppLinkServer.prototype.action = originalAction;
    AppLink.AppLinkServer.prototype.start = originalStart;
    delete require.cache[require.resolve('../src/applink')];
  }
});

test('get_slides is refused, without leaking captions, when the separate slides prompt is denied', async () => {
  const AppLink = require('../vendor/app-link');
  const originalAction = AppLink.AppLinkServer.prototype.action;
  const originalStart = AppLink.AppLinkServer.prototype.start;
  const actions = new Map();
  AppLink.AppLinkServer.prototype.action = function (name, def) { actions.set(name, def); };
  AppLink.AppLinkServer.prototype.start = async function () {};

  const slidesConsent = {};
  const slides = [{ text: 'Confidential roadmap', ts: 1 }];
  const { applink, dialogCalls: calls } = loadAppLink({ dialogResponse: 0 }); // 0 = Don't allow

  try {
    applink.startAppLink({
      snapshot: () => snapshot({ slides }),
      setCapturing: () => {},
      getSlides: () => slides,
      getSlidesConsent: (id) => slidesConsent[id],
      setSlidesConsent: (id, decision) => { slidesConsent[id] = decision; },
      getWindow: () => null
    });

    const getSlides = actions.get('get_slides');
    const caller = { id: 'com.publikhq.iris', name: 'Iris' };
    await assert.rejects(getSlides.handler({}, { caller }), /slide-caption access/);
    assert.equal(calls.length, 1);
    assert.equal(slidesConsent['com.publikhq.iris'], 'denied');

    // set_capturing (already-granted 'action' scope) is untouched by this —
    // it is the vendor library's own #requireScope check, not this handler.
    const setCapturing = actions.get('set_capturing');
    assert.ok(setCapturing, 'set_capturing was still registered normally');
  } finally {
    AppLink.AppLinkServer.prototype.action = originalAction;
    AppLink.AppLinkServer.prototype.start = originalStart;
    delete require.cache[require.resolve('../src/applink')];
  }
});

test('a publik API key is reported as a boolean only — the pk_ value never leaves the process', () => {
  const key = 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32);
  const state = describeState(snapshot({
    settings: { ...SETTINGS, provider: 'publik', apiKeys: { ...SETTINGS.apiKeys, publik: key }, publik: { keyId: 'a'.repeat(12), claimUrl: 'https://publikhq.com/claim/X' } }
  }));
  assert.equal(state.hasKey.publik, true);
  assert.equal(state.provider, 'publik');
  assert.doesNotMatch(JSON.stringify(state), /pk_/);
});

test('set_capturing waits for startup and reports the actual result', async () => {
  const AppLink = require('../vendor/app-link');
  const originalAction = AppLink.AppLinkServer.prototype.action;
  const originalStart = AppLink.AppLinkServer.prototype.start;
  const actions = new Map();
  AppLink.AppLinkServer.prototype.action = function (name, def) { actions.set(name, def); };
  AppLink.AppLinkServer.prototype.start = async function () {};
  const { applink } = loadAppLink();
  let resolve, settled = false;
  const startup = new Promise((done) => { resolve = done; });
  try {
    applink.startAppLink({ snapshot: () => snapshot(), setCapturing: () => startup, getWindow: () => null });
    const pending = actions.get('set_capturing').handler({ active: true }, { caller: { id: 'synthetic', name: 'Synthetic caller' } })
      .then((value) => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    resolve(false);
    assert.deepEqual(await pending, { capturing: false });
  } finally {
    AppLink.AppLinkServer.prototype.action = originalAction;
    AppLink.AppLinkServer.prototype.start = originalStart;
    delete require.cache[require.resolve('../src/applink')];
  }
});
