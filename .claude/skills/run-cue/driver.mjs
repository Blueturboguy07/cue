// cue app driver: launch the real Electron app and drive it over CDP.
// Node >= 22 (global fetch + WebSocket). No npm deps.
//
//   node driver.mjs launch        spawn electron with a debug port, wait for UI
//   node driver.mjs status        capture state + active window count
//   node driver.mjs eval '<js>'   evaluate JS in the renderer (window.cue available)
//   node driver.mjs click <sel>   document.querySelector(sel).click()
//   node driver.mjs ss [name]     screenshot -> /tmp/cue-<name>.png
//   node driver.mjs logs          tail the app stdout/stderr log
//   node driver.mjs quit          graceful close (fires will-quit cleanup), else kill
//
// State: /tmp/cue-run.pid, /tmp/cue-app.log, debug port 9222.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const PORT = 9222;
const PID_FILE = '/tmp/cue-run.pid';
const LOG_FILE = '/tmp/cue-app.log';
const ROOT = new URL('../../../', import.meta.url).pathname; // skill dir -> repo root

const die = (m) => { console.error(m); process.exit(1); };

async function jsonList() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

async function findPage() {
  const list = await jsonList();
  return list?.find((t) => t.type === 'page' && t.url.includes('renderer')) || null;
}

async function connect() {
  const page = await findPage();
  if (!page) die('no renderer page on port 9222 — is the app running? (node driver.mjs launch)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

async function evalJs(expr) {
  const { ws, send } = await connect();
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  if (r.result?.exceptionDetails) die('eval threw: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result?.result?.value;
}

function runningPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'launch': {
    if (runningPid()) die(`already running (pid ${runningPid()}) — quit first or reuse`);
    if (await findPage()) die('port 9222 busy but no pid file — another electron with the debug port?');
    const logFd = (await import('node:fs')).openSync(LOG_FILE, 'w');
    const app = spawn('./node_modules/.bin/electron', ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`], {
      cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    });
    app.on('error', (e) => die(`spawn failed (${e.code}) — run npm install in ${ROOT}`));
    app.unref();
    writeFileSync(PID_FILE, String(app.pid));
    for (let i = 0; i < 60; i++) {
      if (await findPage()) break;
      await new Promise((r) => setTimeout(r, 500));
      if (!runningPid()) die(`app died early — log:\n${readFileSync(LOG_FILE, 'utf8')}`);
    }
    // Wait for the UI itself, not just the page target.
    for (let i = 0; i < 40; i++) {
      if (await evalJs("!!document.getElementById('stop-btn')") === true) {
        console.log(`launched pid=${app.pid}, UI ready. logs: ${LOG_FILE}`);
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    die('UI never rendered #stop-btn — check ' + LOG_FILE);
    break;
  }
  case 'status': {
    const pid = runningPid();
    const state = await evalJs('window.cue ? window.cue.captureState() : null').catch(() => null);
    console.log(JSON.stringify({ pid, capture: state ?? '(not reachable)' }, null, 2));
    break;
  }
  case 'eval':
    if (!args[0]) die('usage: eval "<js expression>"');
    console.log(JSON.stringify(await evalJs(args[0])));
    break;
  case 'click': {
    if (!args[0]) die('usage: click "<css selector>"');
    const ok = await evalJs(`(function(){ const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return false; el.click(); return true; })()`);
    if (ok !== true) die(`selector not found: ${args[0]}`);
    console.log(`clicked ${args[0]}`);
    break;
  }
  case 'ss': {
    const name = args[0] || 'shot';
    const { ws, send } = await connect();
    const r = await send('Page.captureScreenshot', { format: 'png' });
    ws.close();
    writeFileSync(`/tmp/cue-${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log(`/tmp/cue-${name}.png`);
    break;
  }
  case 'logs': {
    if (!existsSync(LOG_FILE)) die('no log yet');
    const tail = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-40).join('\n');
    console.log(tail);
    break;
  }
  case 'quit': {
    const pid = runningPid();
    // Browser.close is graceful: Electron runs will-quit (unregisters shortcuts,
    // unloads the Linux loopback module) instead of dying mid-write.
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      setTimeout(() => process.exit(0), 1500);
    } catch { /* fall through to kill */ }
    setTimeout(() => { if (pid) process.kill(pid, 'SIGTERM'); process.exit(0); }, 2500);
    console.log('quit requested');
    break;
  }
  default:
    die('commands: launch | status | eval "<js>" | click "<sel>" | ss [name] | logs | quit');
}
