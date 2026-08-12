// Keep the overlay from stealing OS focus during normal button/drag use,
// while still allowing a real keyboard caret when the user clicks the
// composer or opens Settings.
//
// Strategy (Electron-native only — no PowerShell / user32 hacks):
//   - Default: setFocusable(false) so clicks on buttons don't take the
//     keyboard from the app underneath.
//   - Typing: setFocusable(true) + focus() SYNCHRONOUSLY on the user gesture
//     (sendSync from renderer mousedown) so Windows grants foreground rights.
//
// The previous WS_EX_NOACTIVATE PowerShell path fought Electron's own style
// bits and async unlock always lost the foreground lock, so keys never arrived.

/**
 * Wire a BrowserWindow for non-activating UI with opt-in typing.
 * @param {Electron.BrowserWindow} win
 */
function installNoActivate(win) {
  if (!win || win.isDestroyed()) return;

  win.__cueAllowFocus = false;
  try { win.setFocusable(false); } catch { /* ignore */ }

  // Reject accidental activation unless typing/settings mode is armed.
  win.on('focus', () => {
    if (win.__cueAllowFocus) return;
    try { if (typeof win.blur === 'function') win.blur(); } catch { /* ignore */ }
    try { win.setFocusable(false); } catch { /* ignore */ }
  });

  // Prefer inactive show so mere "show" does not steal focus.
  const originalShow = win.show.bind(win);
  win.show = (...args) => {
    if (win.__cueAllowFocus) return originalShow(...args);
    try {
      if (typeof win.showInactive === 'function') return win.showInactive();
    } catch { /* fall through */ }
    return originalShow(...args);
  };

  const lock = () => {
    if (win.isDestroyed() || win.__cueAllowFocus) return;
    try { win.setFocusable(false); } catch { /* ignore */ }
  };

  if (win.isVisible()) lock();
  else win.once('ready-to-show', lock);
  win.webContents.on('did-finish-load', lock);
  win.on('show', lock);
}

/**
 * Enable keyboard. MUST be called on the user input stack (sync IPC) so
 * Windows allows SetForegroundWindow / focus.
 */
function allowActivate(win) {
  if (!win || win.isDestroyed()) return false;
  win.__cueAllowFocus = true;
  try { win.setFocusable(true); } catch { /* ignore */ }
  try {
    if (!win.isVisible()) {
      if (typeof win.showInactive === 'function') win.showInactive();
      else win.show();
    }
  } catch { /* ignore */ }
  try { win.moveTop(); } catch { /* ignore */ }
  try { win.focus(); } catch { /* ignore */ }
  try {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.focus();
    }
  } catch { /* ignore */ }
  return true;
}

/** Disable keyboard again; return focus to whatever is underneath. */
function restoreNoActivate(win) {
  if (!win || win.isDestroyed()) return false;
  win.__cueAllowFocus = false;
  try {
    if (win.webContents && !win.webContents.isDestroyed()) {
      // leave webContents alone; blur the window
    }
  } catch { /* ignore */ }
  try { if (typeof win.blur === 'function') win.blur(); } catch { /* ignore */ }
  try { win.setFocusable(false); } catch { /* ignore */ }
  return true;
}

// Stubs kept so older callers don't break
function applyWindowsNoActivate() { return Promise.resolve(true); }
function clearWindowsNoActivate() { return Promise.resolve(true); }
function hwndFromNativeHandle() { return null; }

module.exports = {
  installNoActivate,
  applyWindowsNoActivate,
  clearWindowsNoActivate,
  allowActivate,
  restoreNoActivate,
  hwndFromNativeHandle
};
