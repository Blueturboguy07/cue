// Shared CDP driver for the cue 0.2.11 smoke test (Mac and Windows runner).
// Node 22+ (global fetch + WebSocket). Never prints keys, tokens or claim codes.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function jsonList(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

export class Conn {
  static async open(url) {
    const c = new Conn();
    c.ws = new WebSocket(url);
    c.id = 0; c.pending = new Map(); c.handlers = [];
    await new Promise((res, rej) => { c.ws.addEventListener('open', res, { once: true }); c.ws.addEventListener('error', rej, { once: true }); });
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); return; }
      for (const h of c.handlers) h(m);
    });
    return c;
  }
  call(method, params = {}) {
    return new Promise((res) => { const i = ++this.id; this.pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function waitUntil(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

export function listeningPid(port) {
  if (process.platform !== 'darwin') return null;
  try { return Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]) || null; } catch (_) { return null; }
}

// Launch cue paused (--inspect-brk), install the main hooks, resume.
export async function launchCue({ exe, profile, port, iport, stubGdm, cfg, macHome }) {
  for (const p of [port, iport]) {
    const busy = await fetch(`http://127.0.0.1:${p}/json/version`).then(() => true, () => false);
    if (busy) throw new Error(`port ${p} is already in use`);
  }
  mkdirSync(join(profile, 'ud'), { recursive: true });
  const seed = join(profile, 'ud', 'cue-data.json');
  if (!existsSync(seed)) writeFileSync(seed, JSON.stringify({ windowX: -5000, windowY: 5000 }));
  const out = openSync(join(profile, 'app.log'), 'a');
  const env = { ...process.env };
  if (macHome) env.HOME = profile;
  const args = [`--inspect-brk=127.0.0.1:${iport}`, `--remote-debugging-port=${port}`, `--user-data-dir=${join(profile, 'ud')}`];
  const child = spawn(exe, args, { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  writeFileSync(join(profile, 'pid'), String(child.pid));
  const t = await waitUntil(async () => (await jsonList(iport))[0], 30000);
  if (!t) throw new Error('inspector did not come up');
  const c = await Conn.open(t.webSocketDebuggerUrl);
  let paused = null;
  c.on((m) => { if (m.method === 'Debugger.paused' && !paused) paused = m.params; });
  await c.call('Runtime.enable');
  await c.call('Debugger.enable');
  await c.call('Runtime.runIfWaitingForDebugger');
  await waitUntil(() => paused, 15000, 50);
  if (!paused) throw new Error('main process never paused');
  const frame = paused.callFrames[0];
  const pausedAt = { url: frame.url, line: frame.location.lineNumber };
  const rendererStub = readFileSync(join(HERE, 'renderer-stub.js'), 'utf8').replaceAll('__STUB_GDM__', stubGdm ? 'true' : 'false');
  const hooks = readFileSync(join(HERE, 'main-hooks.js'), 'utf8');
  const expression = `(function (require, CFG) {\n${hooks}\n})(require, ${JSON.stringify({ ...cfg, rendererStub, blankUrl: pathToFileURL(join(HERE, 'blank.html')).href })})`;
  const r = await c.call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true });
  const res = r.result || {};
  if (res.exceptionDetails || !res.result || typeof res.result.value !== 'string') {
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    throw new Error('hook install failed: ' + JSON.stringify(res.exceptionDetails || res).slice(0, 600));
  }
  await c.call('Debugger.resume');
  await c.call('Debugger.disable');
  c.close();
  return { pid: child.pid, pausedAt, hooks: JSON.parse(res.result.value) };
}

export async function pageTarget(port) {
  const list = await jsonList(port);
  const pages = list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/renderer\/index\.html$/.test(new URL(t.url).pathname));
  if (pages.length !== 1) throw new Error('expected exactly 1 cue index page on port ' + port + ', got ' + pages.length);
  return pages[0];
}

const CONFIRM = `(() => ({
  mark: window.__smoke && window.__smoke.mark,
  stubInstalledBeforePage: !!(window.__smoke && window.__smoke.installedAt),
  gumIsStub: navigator.mediaDevices.getUserMedia.toString().includes('CUE_SMOKE_STUB_V1'),
  gdmIsStub: navigator.mediaDevices.getDisplayMedia.toString().includes('CUE_SMOKE_STUB_V1'),
  hasCue: typeof window.cue === 'object' && typeof window.cue.ask === 'function',
  file: location.pathname.split('/').slice(-2).join('/'),
  gum: window.__smoke && window.__smoke.gum, gdm: window.__smoke && window.__smoke.gdm,
}))()`;

// Confirm the target before every action: the right process, the cue page, the stub.
export async function confirmTarget(port, { expectPid, expectGdmStub } = {}) {
  if (expectPid && process.platform === 'darwin') {
    const pid = listeningPid(port);
    if (pid !== Number(expectPid)) throw new Error(`port ${port} belongs to pid ${pid}, not the test cue ${expectPid}`);
  }
  const page = await pageTarget(port);
  const c = await Conn.open(page.webSocketDebuggerUrl);
  const r = await c.call('Runtime.evaluate', { expression: CONFIRM, returnByValue: true });
  c.close();
  const v = r.result && r.result.result && r.result.result.value;
  if (!v || v.mark !== 'CUE_SMOKE_STUB_V1' || !v.gumIsStub || !v.hasCue || v.file !== 'renderer/index.html') throw new Error('target check failed: ' + JSON.stringify(v));
  if (expectGdmStub && !v.gdmIsStub) throw new Error('getDisplayMedia stub missing: ' + JSON.stringify(v));
  return { page, check: v };
}

export async function withPage(port, opts, fn) {
  const { page } = await confirmTarget(port, opts);
  const c = await Conn.open(page.webSocketDebuggerUrl);
  try { return await fn(c); } finally { c.close(); }
}

export async function pageEval(port, opts, expression) {
  return withPage(port, opts, async (c) => {
    const r = await c.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  });
}

const FIND = (sel, text) => `(() => {
  const vis = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { if (e.classList && e.classList.contains('hidden')) return false; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return el.getClientRects().length > 0; };
  const want = ${JSON.stringify(text ?? null)};
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => vis(e) && !e.disabled && (want === null || e.textContent.trim() === want));
  if (!els.length) return { found: false };
  const el = els[0]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y); return { found: true, x, y, text: el.textContent.trim().slice(0, 80), onTop: !!top && (top === el || el.contains(top)) };
})()`;

export async function click(port, opts, sel, text) {
  return withPage(port, opts, async (c) => {
    const r = (await c.call('Runtime.evaluate', { expression: FIND(sel, text), returnByValue: true })).result.result.value;
    if (!r.found) return { clicked: false, sel, text };
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    return { clicked: true, ...r };
  });
}

// Type into the composer through CDP only (no real keyboard events).
export async function typeInto(port, opts, sel, text) {
  const k = await click(port, opts, sel);
  if (!k.clicked) return { typed: false, reason: 'no ' + sel };
  return withPage(port, opts, async (c) => {
    await c.call('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)}).focus()` });
    await c.call('Input.insertText', { text });
    const v = (await c.call('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)}).value`, returnByValue: true })).result.result.value;
    return { typed: v === text, value: v };
  });
}

// A picture of cue's own page only (Page.captureScreenshot), never the screen.
export async function pageShot(port, opts, file) {
  return withPage(port, opts, async (c) => {
    const r = await c.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  });
}

export async function mainEval(iport, expression) {
  const t = (await jsonList(iport))[0];
  const c = await Conn.open(t.webSocketDebuggerUrl);
  try {
    const r = await c.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: false });
    if (r.result && r.result.exceptionDetails) throw new Error('main eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  } finally { c.close(); }
}

export const MAIN_SAFETY = `(() => { const S = global.__smoke; const ipcMain = S.ipcMain;
  const ls = ipcMain.listeners('mic:pcm');
  return { alerts: S.alerts, micPcmBlocked: S.micPcmBlocked, micPermDenied: S.micPermDenied, displayMediaDenied: S.displayMediaDenied,
    askForMediaAccess: S.askForMediaAccess, screencaptureStub: S.screencaptureStub, getSourcesStub: S.getSourcesStub, getSourcesReal: S.getSourcesReal,
    shortcutsBlocked: S.shortcutsBlocked.length, stubbedContents: S.stubbedContents,
    micListeners: ls.length, micListenerIsAlertLogger: ls.length === 1 && ls[0].name === 'smokeMicAlertLogger' }; })()`;

export const LISTEN = `(() => { if (window.__ev) return 'already'; window.__ev = []; const t0 = Date.now(); window.__evT0 = t0;
  const chans = ['capture:state','llm:start','llm:thinking','llm:token','llm:done','llm:error','status','transcript','stt:final','stt:status','slides:update','publik:state'];
  for (const ch of chans) cue.on(ch, (d) => { const e = { ch, ms: Date.now() - t0 };
    if (ch === 'llm:token') e.text = d && d.text;
    else if (ch === 'publik:state') e.d = JSON.stringify({ connected: d && d.connected, revoked: d && d.revoked, keyId: d && d.keyId });
    else e.d = JSON.stringify(d).slice(0, 600);
    window.__ev.push(e); });
  return 'ok'; })()`;

export const ANSWERS = `(() => { const out = []; let cur = null;
  for (const e of (window.__ev || [])) {
    if (e.ch === 'llm:start') { cur = { startMs: e.ms, start: e.d, thinking: 0, firstTokenMs: null, text: '', doneMs: null, error: null }; out.push(cur); }
    else if (!cur) continue;
    else if (e.ch === 'llm:thinking') cur.thinking++;
    else if (e.ch === 'llm:token') { if (cur.firstTokenMs === null) cur.firstTokenMs = e.ms; cur.text += e.text || ''; }
    else if (e.ch === 'llm:done') cur.doneMs = e.ms;
    else if (e.ch === 'llm:error') { cur.error = e.d; cur.doneMs = e.ms; }
  }
  return out.map((a) => ({ ...a, chars: a.text.length, cutOff: a.text.includes('(Cut off:'), empty: !a.text.trim() })); })()`;

export function wavToSpeech(path) {
  const b = readFileSync(path);
  let off = 12, rate = 16000, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!data) throw new Error('no data chunk in ' + path);
  return { b64: data.toString('base64'), rate, seconds: data.length / 2 / rate };
}
