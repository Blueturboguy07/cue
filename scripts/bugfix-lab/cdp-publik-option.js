// Smoke helper: on the already-launched cue (CDP port in CDP_PORT), read
// whether the build carries a publik app token (publikState().available) and
// whether a user can see the "publik API" button in the Settings picker.
// Prints one JSON line. Never presses anything that mints a key.
// Exit 0 = observed, 3 = could not observe.
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || '9222';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      page = list.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
    } catch (_) { /* not up yet */ }
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) { console.log(JSON.stringify({ ok: false, error: 'no cue index page' })); process.exit(3); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0;
  const evalJs = (expression) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === myId) { ws.off('message', onMsg); resolve(m.result && m.result.result ? m.result.result.value : null); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const out = await evalJs(`(async () => {
    const s = await window.cue.publikState();
    const info = await window.cue.platformInfo().catch(() => null);
    const b = document.querySelector('#provider-publik');
    const ob = document.querySelector('#ob-skip'); if (ob && ob.offsetParent !== null) ob.click();
    const sb = document.querySelector('#tb-settings-btn'); if (sb) sb.click();
    await new Promise((r) => setTimeout(r, 800));
    const visible = !!b && b.offsetParent !== null && !b.classList.contains('hidden');
    return JSON.stringify({ ok: true, available: s.available, selected: s.selected, connected: s.connected,
      publikButtonVisible: visible, publikButtonText: b ? b.textContent.trim() : null, platform: info });
  })()`);
  console.log(out);
  ws.close();
  process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(3); });
