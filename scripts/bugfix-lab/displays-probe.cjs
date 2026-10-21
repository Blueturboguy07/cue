// bugfix-lab oracle (cue-20261019-c0d7c6), two-display layouts. For each scenario: seed settings (windowX/windowY),
// launch the real app with electron's `screen` stubbed (screen-stub.cjs), then read the toolbar Drag pill's rect
// from the renderer (getBoundingClientRect + window.screenX/Y) and test it against the stubbed workAreas. Drag
// scenarios press the pill (renderer cue.windowDragStart), move the stubbed cursor, release (cue.windowDragEnd),
// then relaunch to see where the saved position puts the pill. Exit 1 if any check leaves the pill outside every workArea.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

const LAYOUTS = {
  // retry-3 layout: primary RIGHT at (1920,0); secondary LEFT at (0,200), lower, 1.25x
  A: [{ x: 1920, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true, taskbar: 40 }, { x: 0, y: 200, width: 1920, height: 1080, scaleFactor: 1.25, taskbar: 0 }],
  // mirror: primary LEFT at (0,0); secondary RIGHT sits higher, at (1920,-200) (the photo's physical arrangement if left is primary)
  // physically valid Windows layout (primary is always at 0,0): primary RIGHT-higher at (0,0), secondary LEFT lower at (-1920,200), mixed DPI
  C: [{ x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: true, taskbar: 40 }, { x: -1920, y: 200, width: 1920, height: 1080, scaleFactor: 1.5, taskbar: 0 }],
  B: [{ x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1.25, primary: true, taskbar: 40 }, { x: 1920, y: -200, width: 1920, height: 1080, scaleFactor: 1, taskbar: 0 }]
};
const inside = (p, w) => p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height;
const SCEN = [
  { n: 'A1 seed on left display (500,300)', L: 'A', seed: { windowX: 500, windowY: 300 } },
  { n: 'A2 seed on left display near its top (100,205)', L: 'A', seed: { windowX: 100, windowY: 205 } },
  { n: 'A3 seed on left display (1000,210)', L: 'A', seed: { windowX: 1000, windowY: 210 } },
  { n: 'A4 fresh, drag pill to left display (500,260), restart', L: 'A', seed: null, drag: { x: 500, y: 260 } },
  { n: 'A5 fresh, drag pill to far left top (30,205), restart', L: 'A', seed: null, drag: { x: 30, y: 205 } },
  { n: 'A6 fresh, drag pill to right display top (2000,2), restart', L: 'A', seed: null, drag: { x: 2000, y: 2 } },
  { n: 'C1 seed on left (lower) display (-1500,210)', L: 'C', seed: { windowX: -1500, windowY: 210 } },
  { n: 'C2 seed on left display just under its top (-300,201)', L: 'C', seed: { windowX: -300, windowY: 201 } },
  { n: 'C3 fresh, drag pill to left display (-800,205), restart', L: 'C', seed: null, drag: { x: -800, y: 205 } },
  { n: 'C4 fresh, drag pill across the seam to (-5,205), restart', L: 'C', seed: null, drag: { x: -5, y: 205 } },
  { n: 'C5 fresh, drag pill to (-1900,1000) bottom-left, restart', L: 'C', seed: null, drag: { x: -1900, y: 1000 } },
  { n: 'B1 seed on higher right display (2500,-150)', L: 'B', seed: { windowX: 2500, windowY: -150 } },
  { n: 'B2 fresh, drag pill onto the higher right display (2300,-150), restart', L: 'B', seed: null, drag: { x: 2300, y: -150 } },
  { n: 'B3 fresh, drag pill to right display just past the seam (1930,-190), restart', L: 'B', seed: null, drag: { x: 1930, y: -190 } }
];

async function launch(layout, dir, port, cursorFile) {
  const log = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  const p = spawn(exe, ['-r', path.join(__dirname, 'screen-stub.cjs'), '.', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`],
    { cwd: root, stdio: ['ignore', log, log], env: { ...process.env, LAB_LAYOUT: JSON.stringify(layout), LAB_CURSOR: cursorFile } });
  const end = Date.now() + 40000; let t = null;
  while (Date.now() < end && !t) { try { t = (await getJson(`http://127.0.0.1:${port}/json/list`)).find((x) => x.type === 'page' && /index\.html$/.test(x.url || '')); } catch (_) {} if (!t) await sleep(500); }
  if (!t) { p.kill(); throw new Error('no cue page target; stderr: ' + fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8').slice(-600)); }
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); } });
  const ev = (expression) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res: (r) => res(r.result.value), rej }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  await sleep(2500);
  await ev(`(function(){const s=document.getElementById('ob-skip'),c=document.getElementById('onboard-scrim');if(s&&c&&!c.classList.contains('hidden'))s.click();})()`);
  await sleep(600);
  return { p, ws, ev, close: async () => { try { ws.close(); } catch (_) {} p.kill(); await sleep(1500); } };
}
const pill = (h) => h.ev(`(function(){const r=document.querySelector('.drag-pill').getBoundingClientRect();return JSON.stringify({sx:window.screenX,sy:window.screenY,l:r.left,t:r.top,w:r.width,h:r.height,dpr:window.devicePixelRatio});})()`).then(JSON.parse);
function judge(tag, m, layout) {
  const wa = layout.map((d) => ({ x: d.x, y: d.y, width: d.width, height: d.height - (d.taskbar || 0) }));
  const c = { x: m.sx + m.l + m.w / 2, y: m.sy + m.t + m.h / 2 };
  const ok = wa.some((w) => inside(c, w));
  const full = wa.some((w) => m.sx + m.l >= w.x && m.sy + m.t >= w.y && m.sx + m.l + m.w <= w.x + w.width && m.sy + m.t + m.h <= w.y + w.height);
  console.log(`  ${tag}: window@(${m.sx},${m.sy}) pill center (${Math.round(c.x)},${Math.round(c.y)}) size ${Math.round(m.w)}x${Math.round(m.h)} -> ${ok ? (full ? 'inside a workArea' : 'center inside, edge clipped') : 'OUTSIDE EVERY DISPLAY (dead space)'}`);
  return ok;
}

(async () => {
  let bad = 0, ran = 0, port = 9400;
  for (const s of SCEN) {
    const layout = LAYOUTS[s.L];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-lab-'));
    const cur = path.join(dir, 'cursor.json'); fs.writeFileSync(cur, '{"x":0,"y":0}');
    if (s.seed) fs.writeFileSync(path.join(dir, 'cue-data.json'), JSON.stringify(s.seed));
    console.log(`SCENARIO ${s.n}`);
    try {
      let h = await launch(layout, dir, ++port, cur);
      if (!/STUB_ACTIVE/.test(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'))) throw new Error('screen stub did not take effect');
      let m = await pill(h); ran++;
      if (!judge('startup', m, layout)) bad++;
      if (s.drag) {
        const c0 = { x: Math.round(m.sx + m.l + m.w / 2), y: Math.round(m.sy + m.t + m.h / 2) };
        fs.writeFileSync(cur, JSON.stringify(c0));
        await h.ev('cue.windowDragStart()'); await sleep(100);
        for (let i = 1; i <= 10; i++) { fs.writeFileSync(cur, JSON.stringify({ x: Math.round(c0.x + (s.drag.x - c0.x) * i / 10), y: Math.round(c0.y + (s.drag.y - c0.y) * i / 10) })); await sleep(40); }
        await sleep(200);
        m = await pill(h); console.log(`  cursor ${c0.x},${c0.y} -> ${s.drag.x},${s.drag.y}`); ran++;
        if (!judge('during drag', m, layout)) bad++;
        await h.ev('cue.windowDragEnd()'); await sleep(500);
        m = await pill(h); ran++;
        if (!judge('after drag-end', m, layout)) bad++;
        console.log('  saved: ' + fs.readFileSync(path.join(dir, 'cue-data.json'), 'utf8').match(/"window[XY]":\s*-?\d+/g));
        await h.close();
        h = await launch(layout, dir, ++port, cur);
        m = await pill(h); ran++;
        if (!judge('after restart', m, layout)) bad++;
      }
      await h.close();
    } catch (e) { console.log('  scenario error: ' + (e && e.message || e)); process.exitCode = 2; }
  }
  console.log(`CHECKS ran=${ran} outside=${bad}`);
  if (process.exitCode === 2 && ran === 0) process.exit(2);
  process.exit(bad ? 1 : 0);
})();
