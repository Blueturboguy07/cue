// bugfix-lab oracle helper — cue-windows-meeting-audio-not-started
//
// Drives the REAL, already-launched cue renderer over Chrome DevTools Protocol:
//   1. finds cue's main window target on the given --remote-debugging-port,
//   2. instruments navigator.mediaDevices.getDisplayMedia in place (wraps the
//      real function so the app's own click handler still calls it — this does
//      not change what the app does, it just records what came back),
//   3. dismisses the first-run onboarding overlay if present (#ob-skip),
//   4. dispatches a REAL mouse click (CDP Input.dispatchMouseEvent, which
//      carries transient user activation the way a real click does — getDisplayMedia
//      requires this) on #stop-btn, the same button labelled "Start / stop
//      listening" that reporters click,
//   5. polls until the instrumented getDisplayMedia call settles (or times out),
//   6. reads the user-visible status text cue itself renders into #cue-status,
//   7. captures a screenshot,
//   8. prints one JSON line of evidence to stdout.
//
// This is not a tautology: it observes the real browser API's real return
// value and the real DOM text cue's own renderer.js writes on failure —
// exactly the entry point cue's own startSystemAudio() calls.
//
// Exit codes (of THIS script — the .ps1 wrapper maps these to BUGFIX_LAB_*):
//   0 = observation completed (evidence JSON printed; caller inspects it)
//   3 = could not complete the observation (CDP unreachable, button missing,
//       getDisplayMedia never invoked within the timeout) — "oracle could not run"

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || '9222';
const TIMEOUT_MS = 20000;
const SETTLE_TIMEOUT_MS = 8000; // reporters describe a sub-second failure; 8s is generous

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
  const eventHandlers = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg.method, msg.params);
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
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }
  function onEvent(fn) { eventHandlers.push(fn); }
  return { ready, send, onEvent, close: () => ws.close() };
}

async function main() {
  const target = await findPageTarget();
  const client = cdpClient(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  const consoleLines = [];
  client.onEvent((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      try {
        const text = (params.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' ');
        consoleLines.push(`[${params.type}] ${text}`);
      } catch (_) {}
    }
  });

  // 1. Instrument the real getDisplayMedia in place.
  const instrumentResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
          window.__oracle = { supported: false };
          return JSON.stringify(window.__oracle);
        }
        window.__oracle = { supported: true, called: false };
        const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = function(constraints) {
          window.__oracle.called = true;
          window.__oracle.constraints = constraints;
          return orig(constraints).then(function(stream) {
            window.__oracle.settled = true;
            window.__oracle.ok = true;
            window.__oracle.audioTracks = stream.getAudioTracks().length;
            window.__oracle.videoTracks = stream.getVideoTracks().length;
            stream.getTracks().forEach(function(t) { try { t.stop(); } catch (_) {} });
            return stream;
          }).catch(function(err) {
            window.__oracle.settled = true;
            window.__oracle.ok = false;
            window.__oracle.errorName = err && err.name;
            window.__oracle.errorMessage = err && err.message;
            throw err;
          });
        };
        return JSON.stringify(window.__oracle);
      })()
    `,
    returnByValue: true,
  });
  const instrumented = JSON.parse(instrumentResult.result.value);
  if (!instrumented.supported) {
    console.log(JSON.stringify({ ok: false, could_not_run: true, reason: 'getDisplayMedia not supported in this renderer' }));
    process.exit(3);
  }

  // 2. Dismiss onboarding if present (first-run overlay would eat the click).
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
  await sleep(300);

  // 3. Find #stop-btn's screen coordinates.
  const rectResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        const el = document.getElementById('stop-btn');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `,
    returnByValue: true,
  });
  if (!rectResult.result.value) {
    console.log(JSON.stringify({ ok: false, could_not_run: true, reason: '#stop-btn not found in DOM' }));
    process.exit(3);
  }
  const { x, y } = JSON.parse(rectResult.result.value);

  // 4. Real click via CDP Input — carries transient user activation, same as a
  //    genuine click, which getDisplayMedia requires.
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

  // 5. Poll until the instrumented call settles or times out.
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let oracleState = null;
  while (Date.now() < deadline) {
    const r = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__oracle || {})',
      returnByValue: true,
    });
    oracleState = JSON.parse(r.result.value);
    if (oracleState.settled) break;
    await sleep(250);
  }

  // 6. Read the user-visible status text cue itself writes on failure.
  const statusResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        const el = document.getElementById('cue-status');
        return el ? el.textContent : null;
      })()
    `,
    returnByValue: true,
  });
  const statusText = statusResult.result.value;

  // 7. Screenshot for evidence.
  let screenshotBase64 = null;
  try {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    screenshotBase64 = shot.data;
  } catch (_) {}

  client.close();

  const evidence = {
    ok: true,
    called: !!(oracleState && oracleState.called),
    settled: !!(oracleState && oracleState.settled),
    getDisplayMediaOk: oracleState ? oracleState.ok : null,
    audioTracks: oracleState ? oracleState.audioTracks : null,
    videoTracks: oracleState ? oracleState.videoTracks : null,
    errorName: oracleState ? oracleState.errorName : null,
    errorMessage: oracleState ? oracleState.errorMessage : null,
    statusText,
    consoleLines: consoleLines.slice(-40),
    screenshotBase64,
  };

  if (!oracleState || !oracleState.called) {
    console.log(JSON.stringify({ ...evidence, ok: false, could_not_run: true, reason: 'getDisplayMedia was never invoked after the click (button/handler not wired the way expected)' }));
    process.exit(3);
  }

  console.log(JSON.stringify(evidence));
  process.exit(0);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, could_not_run: true, reason: String(err && err.stack || err) }));
  process.exit(3);
});
