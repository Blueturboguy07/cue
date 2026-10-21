// bugfix-lab helper (cue-20261019-c0d7c6): CDP side of the toolbar-drag oracle.
//   node drag-probe.cjs prep    -> dismiss onboarding, record pointer events, print drag-handle geometry as JSON
//   node drag-probe.cjs state   -> print window position + recorded pointer events as JSON
// Never sends input itself: the drag is made with the real OS mouse by the .ps1.
const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.CDP_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function target() {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page' && /index\.html$/.test(x.url || ''));
      if (t) return t;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no cue page target on CDP port ' + PORT);
}

async function main() {
  const mode = process.argv[2];
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  const evaluate = (expression) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res: (r) => res(r.result.value), rej });
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

  if (mode === 'prep') {
    await evaluate(`(function(){const s=document.getElementById('ob-skip'),c=document.getElementById('onboard-scrim');if(s&&c&&!c.classList.contains('hidden'))s.click();})()`);
    await sleep(600);
    await evaluate(`(function(){
      window.__ev=[];
      for (const t of ['pointerdown','pointerup','lostpointercapture']) document.getElementById('toolbar').addEventListener(t,(e)=>window.__ev.push(t+'@'+Math.round(e.clientX)+','+Math.round(e.clientY)),true);
    })()`);
    const out = await evaluate(`(function(){
      const p=document.querySelector('.drag-pill'), r=p.getBoundingClientRect(), d=window.devicePixelRatio;
      return JSON.stringify({ dpr:d, sx:window.screenX, sy:window.screenY, iw:innerWidth, ih:innerHeight,
        x:Math.round((window.screenX + r.x + r.width/2)*d), y:Math.round((window.screenY + r.y + r.height/2)*d),
        visible: getComputedStyle(document.getElementById('toolbar')).display !== 'none' });
    })()`);
    console.log(out);
  } else if (mode === 'state') {
    console.log(await evaluate(`JSON.stringify({ sx:window.screenX, sy:window.screenY, ev:window.__ev||[] })`));
  } else throw new Error('mode?');
  ws.close();
}
main().catch((e) => { console.error(String(e && e.stack || e)); process.exit(3); });
