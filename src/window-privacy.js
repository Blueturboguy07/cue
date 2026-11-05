// An accepted OS request is not receiver verification. Keep that distinction
// in the state used by every owned window and in the persistent UI notice.
function protectionPolicy({ platform, winBuild = 0, sessionName, noProtect }) {
  if (/^(1|true|yes|on)$/i.test(String(noProtect || '').trim())) return { status: 'disabled', reason: 'debug-override' };
  if (platform === 'linux') return { status: 'unsupported', reason: 'linux' };
  if (platform === 'win32') {
    if (!Number.isSafeInteger(winBuild) || winBuild < 19041) return { status: 'unsupported', reason: 'windows-build' };
    if (sessionName !== 'Console') return { status: 'disabled', reason: sessionName ? 'windows-remote-session' : 'windows-session-unknown' };
  } else if (platform !== 'darwin') return { status: 'unsupported', reason: 'platform' };
  return { status: 'requested', reason: 'os-request' };
}

function createWindowPrivacy(options) {
  const windows = new Map();
  let token = 0, hidden = false, paused = false, recoverable = false;
  function info(contents) {
    const entry = windows.get(contents);
    return {
      paused, hidden, recoverable,
      windowToken: entry?.token,
      protection: { ...(entry?.protection || { status: 'pending', reason: 'window-not-ready' }), verified: false }
    };
  }
  function notify() {
    for (const [contents, entry] of windows) {
      if (!entry.window.isDestroyed()) { try { contents.send('privacy:state', info(contents)); } catch (_) {} }
    }
  }
  function show(entry) {
    if (!entry || hidden || !entry.loaded || !entry.ready || entry.window.isDestroyed()) return;
    if (entry.kind === 'permissions') entry.window.show();
    else entry.window.showInactive();
  }
  return {
    info,
    get paused() { return paused; },
    get hidden() { return hidden; },
    get recoverable() { return recoverable; },
    register(window, kind) {
      const contents = window.webContents;
      const protection = { ...protectionPolicy(options) };
      if (protection.status === 'requested') {
        try {
          if (window.setContentProtection(true) === false) throw new Error('request rejected');
        } catch (_) { protection.status = 'error'; protection.reason = 'api-error'; }
      }
      const entry = { window, kind, token: ++token, protection, loaded: false, ready: false };
      windows.set(contents, entry);
      contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-redirect', (event) => event.preventDefault());
      const reset = () => {
        entry.ready = entry.loaded = false;
        entry.token = ++token;
        window.hide();
      };
      contents.on('did-start-loading', reset);
      contents.on('render-process-gone', reset);
      contents.on('did-finish-load', () => { entry.loaded = true; show(entry); });
      window.on('closed', () => windows.delete(contents));
    },
    ready(contents, suppliedToken) {
      const entry = windows.get(contents);
      if (!entry || suppliedToken !== entry.token) return false;
      if (entry.ready) return true;
      entry.ready = true;
      show(entry);
      return true;
    },
    setRecoverable(value) { recoverable = value === true; notify(); },
    setPaused(value) { paused = value === true; notify(); },
    hide() {
      if (!recoverable) return false; // Never strand an icon-less application.
      hidden = true;
      for (const { window } of windows.values()) if (!window.isDestroyed()) window.hide();
      notify();
      return true;
    },
    restore() {
      hidden = false;
      notify();
      for (const entry of windows.values()) show(entry);
    },
    show(window) { show(windows.get(window?.webContents)); },
    canPrompt(window) {
      const entry = windows.get(window?.webContents);
      return !hidden && !paused && !!entry?.ready && !!entry?.loaded && !window.isDestroyed();
    }
  };
}

module.exports = { protectionPolicy, createWindowPrivacy };
