// The publik app link: how Iris asks cue what it is doing.
//
// Before this, an assistant helping someone with cue could only see what was on
// screen and whatever had already been written to a log file. Neither answers
// the question people actually report — "it isn't listening any more" — because
// the reason is in memory: a 403 from the speech model, a shortcut another app
// grabbed first, a Screen Recording grant that was never given.
//
// So cue answers questions instead. Nothing is exposed until the user says yes,
// and the transcript never leaves this process; see `describeState` below.
//
// The library lives in vendor/app-link and is maintained in the publik repo at
// packages/app-link. Do not edit it here.

const { app, dialog, ipcMain } = require('electron');
const { AppLinkServer, ERROR_CODES } = require('../vendor/app-link');
const { describeState, consentCopy } = require('./applink-state');

let link = null;
let consentSeq = 0;

/** Nobody is going to sit in front of an unanswered sheet for longer than this. */
const CONSENT_TIMEOUT_MS = 120_000;

/**
 * Ask inside cue's own window.
 *
 * The first version of this used dialog.showMessageBox, and it was unusable:
 * cue calls app.dock.hide(), so it is an accessory application and never
 * becomes active on its own. The panel appeared and then would not take a
 * click, because the app it belonged to was not frontmost and nothing was
 * bringing it forward.
 *
 * cue's own window has none of that problem, matches the rest of the app, and
 * carries setContentProtection — so a consent prompt does not show up in a
 * screen share, which for this particular prompt is the right default.
 */
function askInWindow(win, copy, scope, signal) {
  const id = `consent-${++consentSeq}`;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (allowed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('applink:consent-response', onResponse);
      win.removeListener('closed', onClosed);
      signal?.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) { try { win.webContents.send('applink:consent-cancelled', { id }); } catch (_) {} }
      resolve(allowed);
    };
    const onResponse = (_event, payload) => {
      if (_event.sender === win.webContents && payload && payload.id === id) settle(payload.allowed === true);
    };
    const onClosed = () => settle(false);
    const onAbort = () => settle(false);
    const timer = setTimeout(() => settle(false), CONSENT_TIMEOUT_MS);

    ipcMain.on('applink:consent-response', onResponse);
    win.once('closed', onClosed);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { settle(false); return; }

    // cue deliberately never steals focus — except here. A question about who
    // may read your screen activity is the one thing that should interrupt.
    if (!win.isVisible()) win.show();
    app.focus({ steal: true });
    win.focus();

    win.webContents.send('applink:consent-request', { id, scope, ...copy });
  });
}

/** Copy comes from applink-state.js so it can be tested without Electron. */
async function requestConsent(request, deps) {
  const signal = deps?.privacySignal?.();
  if (signal?.aborted || (deps?.canPrompt && !deps.canPrompt())) return false;
  const copy = consentCopy(request);
  const win = deps && deps.getWindow ? deps.getWindow() : null;

  if (win && !win.isDestroyed()) return askInWindow(win, copy, request.scope, signal);

  // No window to ask in — during startup, or after the renderer died. Activate
  // first for the same reason as above, or this panel is equally unclickable.
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Don’t allow', copy.allowLabel],
    defaultId: 0, // Return dismisses with a no.
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
  });
  return !signal?.aborted && (!deps?.canPrompt || deps.canPrompt()) && response === 1;
}

function requirePrivacyAccess(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Cue is privacy-paused; resume explicitly before granting access.');
  error.rpcCode = ERROR_CODES.SCOPE_DENIED;
  throw error;
}

/**
 * @param {object} deps  Live references from main.js — not a snapshot, so
 *   `get_state` reflects the moment it is asked rather than the moment cue
 *   started.
 */
function startAppLink(deps) {
  if (link) return link;

  link = new AppLinkServer({
    appId: 'com.cue.overlay', // Matches electron-builder.cjs. Read off a build, not guessed.
    appSlug: 'cue',
    appName: 'cue',
    appVersion: app.getVersion(),
    stateProvider: () => describeState(deps.snapshot()),
    onConsentRequest: (request) => requestConsent(request, deps),
    diagnosticsProvider: () => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      userDataPath: app.getPath('userData'),
    }),
  });

  // Both directions are recorded, because an action that changes what the
  // microphone is doing should be visible afterwards in the same place a user
  // or a patch agent looks for anything else that happened.
  link.action('set_capturing', {
    description: 'Start or stop listening',
    inputSchema: { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'] },
    handler: async (args, { caller }) => {
      const signal = deps.privacySignal?.();
      requirePrivacyAccess(signal);
      const active = await deps.setCapturing(args.active);
      requirePrivacyAccess(signal);
      link.record({
        level: 'info',
        event: 'applink_set_capturing',
        msg: `${caller.name} ${active ? 'started' : 'stopped'} listening`,
      });
      return { capturing: active };
    },
  });

  // Forward-only slide access: captions leave only via this consented action,
  // never via get_state (which stays counts-only). No images are ever returned.
  //
  // Reading slide captions is a materially different, more sensitive
  // capability than "start/stop listening" — the only other thing the link's
  // 'action' scope currently gates. A caller already trusted for that is NOT
  // automatically trusted for this: it gets its own, separately-recorded
  // consent decision (src/store.js's applinkSlidesConsent), asked for with
  // copy that says specifically what it is (see applink-state.js's 'slides'
  // branch of consentCopy), the first time this action is actually invoked.
  link.action('get_slides', {
    description: 'List auto-captured slide captions for this meeting (memory-only)',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, { caller }) => {
      const signal = deps.privacySignal?.();
      requirePrivacyAccess(signal);
      const getDecision = typeof deps.getSlidesConsent === 'function' ? deps.getSlidesConsent : () => undefined;
      const setDecision = typeof deps.setSlidesConsent === 'function' ? deps.setSlidesConsent : () => {};
      let decision = getDecision(caller.id);
      if (decision !== 'granted' && decision !== 'denied') {
        // verification: 'none' — this layer cannot see the vendor link's own
        // (possibly stronger) verification of the caller, only that it
        // already holds the 'action' scope; hedge rather than overstate it.
        const allowed = await requestConsent({ callerName: caller.name, scope: 'slides', verification: 'none' }, deps);
        requirePrivacyAccess(signal);
        decision = allowed ? 'granted' : 'denied';
        setDecision(caller.id, decision);
        link.record({
          level: 'info',
          event: 'applink_slides_consent',
          msg: `${caller.name} was ${decision === 'granted' ? 'granted' : 'denied'} slide-caption access`,
        });
      }
      if (decision !== 'granted') {
        const error = new Error('the user has not granted slide-caption access to this app');
        error.rpcCode = ERROR_CODES.SCOPE_DENIED;
        throw error;
      }
      requirePrivacyAccess(signal);
      const slides = typeof deps.getSlides === 'function' ? deps.getSlides() : [];
      link.record({
        level: 'info',
        event: 'applink_get_slides',
        msg: `${caller.name} read ${slides.length} slide captions`,
      });
      return { count: slides.length, slides };
    },
  });

  link.start().catch((error) => {
    // A link that will not start must never stop cue from starting. The app
    // worked without this yesterday.
    console.log('[cue] app link unavailable:', error && error.message);
    link = null;
  });

  return link;
}

/** Record an event. Safe before start() and after stop(); does nothing if the link is off. */
function recordEvent(event) {
  if (!link) return null;
  try {
    return link.record(event);
  } catch (_) {
    return null;
  }
}

function appLinkConsentState() {
  return link ? link.consent.snapshot() : { callers: {} };
}

function revokeAppLinkCaller(callerId) {
  return link ? link.consent.revoke(callerId) : false;
}

async function stopAppLink() {
  if (!link) return;
  const current = link;
  link = null;
  await current.stop().catch(() => {});
}

module.exports = {
  startAppLink,
  stopAppLink,
  recordEvent,
  appLinkConsentState,
  revokeAppLinkCaller,
  describeState,
  requestConsent,
};
