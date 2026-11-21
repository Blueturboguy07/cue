// publik-gate.js — the Electron GateUI of the publik module (publik.js): one small window
// that shows the gate's screens before the app's own window. The module decides the words and
// the buttons; this file only draws them and reports the button pressed.
//
// Why a window and not dialog.showMessageBox: on macOS a message box with no parent window
// runs synchronously and ignores `signal`, so the gate could not continue by itself when the
// sign-in poll succeeds. A BrowserWindow with a three-line preload has no such limit.
//
//   const ui = electronGateUI({ appName: "My app" });
//   const gate = await ensureSignedIn(ui);   // shows the screens, resolves once signed in
//   ui.close();                              // the gate window goes away; open the app's window
//
// Closing the gate window before the gate resolves quits the app: there is no way past it.
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { join } = require("node:path");

const PRELOAD = join(__dirname, "publik-gate-preload.cjs");
const CHANNEL = "publik-gate:press";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(screen, appName) {
  const buttons = screen.buttons
    .map((b, i) => `<button type="button"${i === 0 ? ' class="primary" autofocus' : ""} data-action="${esc(b.action)}">${esc(b.label)}</button>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(screen.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
    color: #1b1b1b; background: #fafafa; -webkit-user-select: none; cursor: default; }
  main { padding: 28px 32px; max-width: 420px; box-sizing: border-box; }
  .app { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .55; margin: 0 0 8px; }
  h1 { font-size: 20px; line-height: 1.25; margin: 0 0 10px; }
  p { margin: 0 0 10px; }
  .note { opacity: .7; }
  .buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #c8c8c8; background: #fff; color: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid #1f6feb; outline-offset: 2px; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  @media (prefers-color-scheme: dark) {
    body { color: #ececec; background: #1e1e1e; }
    button { background: #2c2c2c; border-color: #484848; }
    button.primary { background: #2f81f7; border-color: #2f81f7; color: #fff; }
  }
</style></head><body><main>
<p class="app">${esc(appName)}</p>
<h1>${esc(screen.title)}</h1>
<p>${esc(screen.body)}</p>
${screen.note ? `<p class="note">${esc(screen.note)}</p>` : ""}
<div class="buttons">${buttons}</div>
</main><script>
  for (const b of document.querySelectorAll("button")) {
    b.addEventListener("click", () => { if (window.publikGate) window.publikGate.press(b.dataset.action); });
  }
</script></body></html>`;
}

/**
 * The GateUI. `show(screen, signal)` draws the screen and resolves with the action of the
 * button pressed; when `signal` aborts (the poll saw the sign-in), the promise stays pending
 * and the next `show` replaces the screen. `close()` ends the gate and closes the window.
 */
function electronGateUI({ appName = app.getName(), width = 480, height = 380 } = {}) {
  let win = null;
  let done = false;
  let pending = null;

  function create() {
    win = new BrowserWindow({
      width, height, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      show: false, title: "Sign in with publik", autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.once("ready-to-show", () => { if (win && !win.isDestroyed()) win.show(); });
    // A first paint that never comes (a slow renderer) must not hide the gate for good.
    setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 2000).unref?.();
    win.on("closed", () => {
      win = null;
      if (!done) app.quit(); // there is no way past the gate
    });
  }

  function onPress(event, action) {
    if (!win || event.sender !== win.webContents || !pending) return;
    const resolve = pending;
    pending = null;
    resolve(String(action));
  }
  ipcMain.on(CHANNEL, onPress);

  return {
    show(screen, signal) {
      if (!win) create();
      return new Promise((resolve) => {
        pending = resolve;
        signal.addEventListener("abort", () => { if (pending === resolve) pending = null; }, { once: true });
        win.setTitle(screen.title);
        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(screen, appName))}`).catch(() => {});
      });
    },
    openUrl(url) {
      return shell.openExternal(String(url));
    },
    close() {
      done = true;
      pending = null;
      ipcMain.removeListener(CHANNEL, onPress);
      if (win && !win.isDestroyed()) win.close();
      win = null;
    },
  };
}

module.exports = { electronGateUI };
