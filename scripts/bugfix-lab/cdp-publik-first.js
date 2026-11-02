// Smoke helper (v0.2.8 "publik front and center"): on a FRESH launch of the
// installed cue (CDP port in CDP_PORT, launch time in LAUNCH_MS), record what a
// new user sees in the first 3 seconds, then walk the onboarding to the publik
// step, skip it, and open Settings. Saves 4 screenshots. It never presses a
// button that mints a key ("Sign in with publik", "Allow", "Switch to publik").
// Prints one JSON line. Exit 0 = observed, 3 = could not observe.
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || '9223';
const LAUNCH_MS = Number(process.env.LAUNCH_MS || Date.now());

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: what is visible and on top right now.
const READ = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null && !el.classList.contains('hidden');
  const onTop = (el) => { if (!vis(el)) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && (hit === el || el.contains(hit)); };
  const t = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 300) : null; };
  const cta = document.querySelector('#setup-cta');
  const onboard = document.querySelector('#onboard-scrim');
  const visibleSignIn = [...document.querySelectorAll('button')].filter((b) => /Sign in with publik/.test(b.textContent) && onTop(b)).map((b) => b.id || b.className || 'button');
  return {
    onboardingVisible: vis(onboard),
    obTitle: vis(onboard) ? t('#ob-title') : null,
    obBody: vis(onboard) ? t('#ob-body') : null,
    obButtons: vis(onboard) ? [...document.querySelectorAll('#ob-buttons button')].filter(vis).map((b) => b.textContent.trim()) : [],
    setupCta: cta ? { title: t('#setup-cta .setup-title'), body: t('#setup-cta .setup-body'), primary: t('#setup-primary'), primaryOnTop: onTop(document.querySelector('#setup-primary')) } : null,
    signInButtonsOnTop: visibleSignIn,
    settingsOpen: vis(document.querySelector('#settings-scrim')),
    settingsTab: t('.s-tab.on'),
    publikCardStatus: t('#publik-status-note'),
    publikPrimary: vis(document.querySelector('#publik-primary')) ? t('#publik-primary') : null,
    publikPrimaryOnTop: onTop(document.querySelector('#publik-primary')),
    byoOpen: !!(document.querySelector('#byo-section') || {}).open,
    byoSummary: t('#byo-summary'),
    keyInputsVisible: [...document.querySelectorAll('input[type=password]')].filter(vis).length
  };
})()`;

(async () => {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      page = list.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
    } catch (_) { /* not up yet */ }
    if (!page) await sleep(250);
  }
  if (!page) { console.log(JSON.stringify({ ok: false, error: 'no cue index page' })); process.exit(3); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === myId) { ws.off('message', onMsg); resolve(m.result || {}); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalJs = async (expression) => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : null; };
  const shot = async (file) => { const r = await call('Page.captureScreenshot', { format: 'png' }); if (r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return !!r.data; };
  const click = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

  const out = { ok: true };
  // 1. The first screen, 3 s after launch (or as soon as the page exists).
  const wait = LAUNCH_MS + 3000 - Date.now();
  if (wait > 0) await sleep(wait);
  out.firstScreenAtMs = Date.now() - LAUNCH_MS;
  out.firstScreen = await evalJs(READ);
  out.state = await evalJs(`(async () => { const s = await window.cue.publikState(); const g = await window.cue.settingsGet(); return { available: s.available, connected: s.connected, provider: g.provider, onboarded: g.onboarded, meetingAudio: g.meetingAudio }; })()`);
  await shot('win-first-screen.png');
  // 2. Next, Next: the publik step of the onboarding.
  out.publikStep = [];
  for (let i = 0; i < 2; i++) { await click('#ob-next'); await sleep(500); const r = await evalJs(READ); out.publikStep.push({ title: r.obTitle, buttons: r.obButtons, signInOnTop: r.signInButtonsOnTop }); }
  await shot('win-onboarding-publik-step.png');
  // 3. Skip: the overlay prompt.
  await click('#ob-skip'); await sleep(700);
  out.overlay = await evalJs(READ);
  await shot('win-overlay.png');
  // 4. Settings.
  await click('#tb-settings-btn'); await sleep(1000);
  out.settings = await evalJs(READ);
  await shot('win-settings.png');
  await click('#s-close'); await sleep(600);
  console.log(JSON.stringify(out));
  ws.close();
  process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(3); });
