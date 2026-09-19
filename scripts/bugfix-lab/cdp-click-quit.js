// bugfix-lab oracle helper — cue-windows-app-will-not-quit
//
// Drives the REAL, already-launched cue renderer over Chrome DevTools Protocol:
//   1. finds cue's main window target on the given --remote-debugging-port,
//   2. dismisses the first-run onboarding overlay if present (#ob-skip) — cue's
//      own onboarding screen would otherwise sit on top of the toolbar and eat
//      the click, which is not what any reporter describes,
//   3. locates the SAME "Quit cue" toolbar control (#quit-btn) shown in report
//      9b5b37e4's screenshot ("cue top floating thing" — the frameless,
//      always-on-top, taskbar-skipping toolbar cue's main.js creates; this app
//      has no native window frame, no tray icon and no taskbar entry, so
//      #quit-btn is the ONLY in-UI control that can end the process — see
//      log.md for the main.js grep that established this),
//   4. dispatches a REAL mouse click on it (CDP Input.dispatchMouseEvent,
//      which carries transient user activation the same way a genuine click
//      does — this is not a synthetic DOM .click(), it's the same input path
//      Electron's contents.sendInputEvent/OS click delivers),
//   5. captures a screenshot immediately after, for evidence.
//
// This script does NOT decide PRESENT/ABSENT — it only performs the click and
// reports whether it was able to. The .ps1 wrapper decides the verdict by
// polling whether the OS process this script's caller launched is still alive
// afterward, which is the actual, literal thing every reporter describes
// ("app will not close through any UI control").
//
// Exit codes (of THIS script):
//   0 = the click was dispatched successfully (evidence JSON printed to stdout)
//   3 = could not complete the observation (CDP unreachable, button missing) —
//       "oracle could not run"

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || '9222';
const TIMEOUT_MS = 20000;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function findPageTarget() {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
      const target = list.find(
        (t) => t.type === 'page' && (t.title === 'cue' || /index\.html$/.test(t.url || ''))
      );
      if (target) return target;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error('CDP target not found within timeout: ' + (lastErr ? lastErr.message : 'no page target'));
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  function send(method, params = {}) {
    const thisId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(thisId, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id: thisId, method, params }));
      } catch (e) {
        reject(e);
      }
    });
  }
  return { ready, send, close: () => { try { ws.close(); } catch (_) {} } };
}

async function main() {
  const target = await findPageTarget();
  const client = cdpClient(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // 1. Dismiss onboarding if present (first-run overlay would otherwise sit
  //    on top of the toolbar and swallow the click).
  await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        const skip = document.getElementById('ob-skip');
        const scrim = document.getElementById('onboard-scrim');
        if (skip && scrim && !scrim.classList.contains('hidden')) { skip.click(); return true; }
        return false;
      })()
    `,
  });
  await sleep(400);

  // 2. Locate #quit-btn's screen coordinates, and confirm it's the frontmost
  //    element at that point (not obstructed by anything else).
  const rectResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        const el = document.getElementById('quit-btn');
        if (!el) return JSON.stringify({ found: false });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2);
        const y = Math.round(r.y + r.height / 2);
        const top = document.elementFromPoint(x, y);
        const obstructed = !(top === el || el.contains(top));
        return JSON.stringify({ found: true, x, y, obstructed, title: el.title, ariaLabel: el.getAttribute('aria-label') });
      })()
    `,
    returnByValue: true,
  });
  const rect = JSON.parse(rectResult.result.value);
  if (!rect.found) {
    console.log(JSON.stringify({ ok: false, could_not_run: true, reason: '#quit-btn not found in DOM' }));
    process.exit(3);
  }

  // 3. Real click via CDP Input — carries transient user activation, the same
  //    input path as a genuine OS-delivered click.
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });

  const evidence = {
    ok: true,
    clicked: true,
    buttonFound: true,
    buttonObstructed: rect.obstructed,
    buttonTitle: rect.title,
    buttonAriaLabel: rect.ariaLabel,
  };

  // 4. Best-effort screenshot right after the click. If the click actually
  //    quit the app, the connection may already be dying — that failure is
  //    itself evidence the app is closing, so swallow it.
  try {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    evidence.screenshotBase64 = shot.data;
    evidence.stillConnectedAfterClick = true;
  } catch (e) {
    evidence.stillConnectedAfterClick = false;
    evidence.screenshotError = String(e && e.message || e);
  }

  console.log(JSON.stringify(evidence));
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, could_not_run: true, reason: String(err && err.stack || err) }));
  process.exit(3);
});
