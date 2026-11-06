// Evaluated ONCE in cue's main process, while it is paused on the first line of
// main.js (--inspect-brk), before any cue code runs. Wrapped by the launcher as
//   (function (require, CFG) { <this file> })(require, {...})
// 0.2.12: + whisper observer, fault injection, capture:toggle timestamps.
// CFG: { testPng, rendererStub, stubScreenAll, stubScreenLarge, stubScreencapture,
//        denyMic, denyDisplayMedia, observeLLM }
// It never reads or prints a key. It records only counts, model ids, token caps,
// finish reasons and lengths.
const S = global.__smoke = {
  cfg: { ...CFG, rendererStub: '(' + String(CFG.rendererStub || '').length + ' chars)' },
  alerts: [], log: [], llm: [],
  micPcmBlocked: 0, micPermDenied: 0, displayMediaDenied: 0, askForMediaAccess: 0,
  screencaptureStub: 0, getSourcesStub: 0, getSourcesReal: 0, shortcutsBlocked: [],
  stubbedContents: 0,
};
const fs = require('fs');
const Module = require('module');
const EventEmitter = require('events');
const note = (m) => { S.log.push(new Date().toISOString() + ' ' + m); try { process.stdout.write('[smoke] ' + m + '\n'); } catch (_) {} };
const alert = (m) => { S.alerts.push(new Date().toISOString() + ' ' + m); try { process.stderr.write('[SMOKE-ALERT] ' + m + '\n'); } catch (_) {} };

const realElectron = require('electron');
const { app, nativeImage, ipcMain, systemPreferences } = realElectron;
Object.defineProperty(S, 'ipcMain', { value: ipcMain, enumerable: false });

function forward(real, overrides) {
  const o = {};
  for (const k of Object.getOwnPropertyNames(real)) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) continue;
    Object.defineProperty(o, k, { enumerable: true, configurable: true, get: () => real[k], set: (v) => { real[k] = v; } });
  }
  for (const [k, v] of Object.entries(overrides)) Object.defineProperty(o, k, { enumerable: true, configurable: true, writable: true, value: v });
  return o;
}

// 1. Global shortcuts are never registered (they fire on the owner's typing).
const fakeGlobalShortcut = {
  register: (acc) => { S.shortcutsBlocked.push(String(acc)); note('globalShortcut.register blocked: ' + acc); return true; },
  registerAll: (accs) => { for (const a of accs || []) S.shortcutsBlocked.push(String(a)); },
  isRegistered: () => false,
  unregister: () => {},
  unregisterAll: () => {},
};

// 2. desktopCapturer: the fixed test image instead of the screen.
const realDesktopCapturer = realElectron.desktopCapturer;
const fakeDesktopCapturer = {
  getSources: async (opts = {}) => {
    const ts = opts.thumbnailSize;
    const fake = CFG.stubScreenAll || (CFG.stubScreenLarge && ts && ts.width > 64);
    if (!fake) {
      S.getSourcesReal++;
      note('desktopCapturer.getSources REAL ' + JSON.stringify(opts));
      return realDesktopCapturer.getSources(opts);
    }
    S.getSourcesStub++;
    const w = (ts && ts.width) || 150, h = (ts && ts.height) || 150;
    const img = nativeImage.createFromPath(CFG.testPng).resize({ width: w, height: h });
    const d = realElectron.screen.getPrimaryDisplay();
    return [{ id: 'screen:smoke-test-image:0', name: 'cue smoke test image', display_id: String(d.id), thumbnail: img, appIcon: null }];
  },
};

// 3. child_process: /usr/sbin/screencapture writes a copy of the test image.
const realChildProcess = require('child_process');
const isShot = (f) => /screencapture/i.test(String(f || ''));
const cpOverrides = {
  execFile: function execFile(file, args, ...rest) {
    if (isShot(file)) {
      S.screencaptureStub++;
      const cb = rest.find((x) => typeof x === 'function');
      const out = Array.isArray(args) ? args[args.length - 1] : null;
      fs.copyFile(CFG.testPng, out, (err) => { note('screencapture stubbed -> test image'); if (cb) cb(err || null, '', ''); });
      const ee = new EventEmitter(); ee.pid = 0; ee.kill = () => {};
      return ee;
    }
    return realChildProcess.execFile.apply(realChildProcess, arguments);
  },
};
for (const name of ['spawn', 'exec', 'execSync', 'spawnSync', 'execFileSync']) {
  cpOverrides[name] = function () {
    const cmd = [arguments[0]].concat(Array.isArray(arguments[1]) ? arguments[1] : []).join(' ');
    if (isShot(cmd)) { alert(name + ' tried screencapture; blocked'); throw new Error('screencapture is blocked in the smoke test'); }
    return realChildProcess[name].apply(realChildProcess, arguments);
  };
}

// 4. LLM observer: model, max_tokens, image yes/no, finish reason, lengths.
let wrappedOpenAI = null;
function tapStream(stream, rec) {
  if (!stream || stream.__smokeTapped || typeof stream[Symbol.asyncIterator] !== 'function') return;
  stream.__smokeTapped = true;
  const inner = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = async function* () {
    try {
      for await (const ch of inner()) {
        rec.chunks++;
        const c = ch && ch.choices && ch.choices[0];
        if (c) {
          const d = c.delta || {};
          rec.contentChars += (d.content || '').length;
          rec.reasoningChars += (d.reasoning || d.reasoning_content || '').length;
          if (c.finish_reason) rec.finish = c.finish_reason;
        }
        if (ch && ch.usage) rec.usage = ch.usage;
        yield ch;
      }
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 200);
      throw e;
    } finally {
      rec.endMs = Date.now() - rec.t;
    }
  };
}

// 4b. Whisper observer (0.2.12): model, prompt, audio bytes, text, timing.
// The text is the transcription of the injected TEST speech file only.
// Fault injection: S.sttFaults is a queue of { status, retryAfterS, times,
// afterToggles, label }. A matching call throws the SDK's own APIError BEFORE
// any request is sent (no network, no charge). afterToggles: the rule waits
// until capture:toggle has been called at least that many times.
S.stt = []; S.sttFaults = []; S.toggles = [];
function wrapTranscriptions(client, Real) {
  const tr = client.audio && client.audio.transcriptions;
  if (!tr || tr.__smoke) return;
  tr.__smoke = true;
  const orig = tr.create.bind(tr);
  tr.create = async (body, reqOpts) => {
    const rec = { n: S.stt.length + 1, t: Date.now(), at: new Date().toISOString(), model: body && body.model,
      prompt: String((body && body.prompt) || ''), bytes: body && body.file && body.file.size, text: null, error: null, injected: null, endMs: null,
      togglesAtStart: S.toggles.length };
    S.stt.push(rec);
    const rule = S.sttFaults.find((r) => r.times > 0 && (!r.afterToggles || S.toggles.length >= r.afterToggles) && (!r.afterCalls || rec.n > r.afterCalls));
    if (rule && rule.delayMs) {
      // A slow answer, not a failure: wait, then send the real request.
      rule.times--; rec.injected = { delayMs: rule.delayMs, label: rule.label || null };
      note('stt call #' + rec.n + ' delayed ' + rule.delayMs + ' ms by injection');
      await new Promise((r) => setTimeout(r, rule.delayMs));
    } else if (rule) {
      rule.times--;
      const headers = rule.retryAfterS ? { 'retry-after': String(rule.retryAfterS) } : {};
      const err = Real.APIError.generate(rule.status || 429, { error: { message: 'smoke-injected ' + (rule.label || 'fault') } }, undefined, headers);
      rec.injected = { status: rule.status || 429, retryAfterS: rule.retryAfterS || null, label: rule.label || null };
      rec.error = String(err && err.message).slice(0, 160); rec.endMs = 0;
      note('stt call #' + rec.n + ' FAILED by injection (' + (rule.label || '') + ')');
      throw err;
    }
    note('stt call #' + rec.n + ' bytes=' + rec.bytes + ' promptChars=' + rec.prompt.length);
    try {
      const res = await orig(body, reqOpts);
      rec.text = typeof res === 'string' ? res : (res && res.text);
      return res;
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 200); rec.status = e && e.status;
      throw e;
    } finally { rec.endMs = Date.now() - rec.t; }
  };
}

// 4c. Wire view (0.2.13): when cue gives the SDK its own fetch (publik chat
// clients do), wrap it to record the JSON body's field names and caps of each
// chat request as it leaves (no message text, no headers, no key).
S.wire = []; S.chatFaults = [];
function smokeWireOpts(opts) {
  if (!opts || typeof opts.fetch !== 'function') return opts;
  const inner = opts.fetch;
  return { ...opts, fetch: async (input, init) => {
    try {
      const url = String((input && input.url) || input);
      if (/chat\/completions/.test(url) && init && typeof init.body === 'string') {
        const b = JSON.parse(init.body);
        S.wire.push({ at: new Date().toISOString(), host: new URL(url).host, path: new URL(url).pathname, keys: Object.keys(b).sort(), model: b.model, max_tokens: b.max_tokens, stream: b.stream,
          reasoning_effort: 'reasoning_effort' in b ? b.reasoning_effort : '(absent)', reasoning: 'reasoning' in b ? JSON.stringify(b.reasoning) : '(absent)', messages: Array.isArray(b.messages) ? b.messages.length : null });
      }
    } catch (_) {}
    return inner(input, init);
  } };
}
// Chat fault injection (content-filter simulation): S.chatFaults is a queue of
// { times, model?, chunks: [text...], finish } rules. A matching call sends NO
// request: cue gets a fake stream with those chunks and that finish reason.
function fakeChatPromise(rule) {
  const chunks = (rule.chunks || []).map((c) => ({ choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }));
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: rule.finish || 'content_filter' }] });
  const stream = { async *[Symbol.asyncIterator]() { for (const ch of chunks) { await new Promise((r) => setTimeout(r, 60)); yield ch; } } };
  const data = Promise.resolve(stream);
  return { withResponse: async () => ({ data: stream, response: new Response(null, { status: 200 }) }), then: (a, b) => data.then(a, b), catch: (b) => data.catch(b) };
}
function wrapOpenAI(Real) {
  if (wrappedOpenAI) return wrappedOpenAI;
  class SmokeOpenAI extends Real {
    constructor(opts) {
      super(smokeWireOpts(opts));
      wrapTranscriptions(this, Real);
      const comp = this.chat && this.chat.completions;
      if (!comp || comp.__smoke) return;
      comp.__smoke = true;
      const orig = comp.create.bind(comp);
      const baseURL = this.baseURL;
      comp.create = (body, reqOpts) => {
        let host = '';
        try { host = new URL(baseURL).host; } catch (_) {}
        const rec = {
          t: Date.now(), at: new Date().toISOString(), host, model: body && body.model,
          max_tokens: body && body.max_tokens, stream: !!(body && body.stream),
          image: JSON.stringify((body && body.messages) || []).includes('"image_url"'),
          finish: null, contentChars: 0, reasoningChars: 0, chunks: 0, usage: null, error: null, endMs: null,
        };
        S.llm.push(rec);
        const rule = S.chatFaults.find((r) => r.times > 0 && (!r.model || r.model === rec.model));
        if (rule) {
          rule.times--; rec.injected = { finish: rule.finish || 'content_filter', chunks: (rule.chunks || []).length, label: rule.label || null };
          rec.finish = rule.finish || 'content_filter'; rec.contentChars = (rule.chunks || []).join('').length; rec.endMs = 0;
          note('llm request model=' + rec.model + ' max_tokens=' + rec.max_tokens + ' answered by the harness (simulated ' + rec.finish + ', no request sent)');
          return fakeChatPromise(rule);
        }
        note('llm request model=' + rec.model + ' max_tokens=' + rec.max_tokens + ' image=' + rec.image);
        const p = orig(body, reqOpts);
        if (p && typeof p.withResponse === 'function') {
          const ow = p.withResponse.bind(p);
          p.withResponse = async () => { const r = await ow(); tapStream(r && r.data, rec); return r; };
        }
        if (p && typeof p.then === 'function') {
          const ot = p.then.bind(p);
          p.then = (onOk, onErr) => ot((s) => { tapStream(s, rec); return onOk ? onOk(s) : s; }, onErr);
        }
        return p;
      };
    }
  }
  wrappedOpenAI = SmokeOpenAI;
  return SmokeOpenAI;
}

// Runner only: keep the claim URL in memory (never logged), open no browser.
S.externalUrls = [];
Object.defineProperty(S, 'externalUrls', { enumerable: false, value: S.externalUrls });
const electronOverrides = { globalShortcut: fakeGlobalShortcut, desktopCapturer: fakeDesktopCapturer };
if (CFG.captureExternal) {
  electronOverrides.shell = forward(realElectron.shell, {
    openExternal: async (url) => { S.externalUrls.push(String(url)); note('shell.openExternal captured (url not logged)'); },
  });
}
const fakeElectron = forward(realElectron, electronOverrides);
const fakeChildProcess = forward(realChildProcess, cpOverrides);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (CFG.stubScreencapture && (request === 'child_process' || request === 'node:child_process')) return fakeChildProcess;
  const r = origLoad.apply(this, arguments);
  if (CFG.observeLLM && request === 'openai') return wrapOpenAI(r);
  return r;
};

// 5. The main-process mic PCM listener is replaced by an alert logger.
const realOn = ipcMain.on;
ipcMain.on = function (channel, listener) {
  if (channel === 'mic:pcm') {
    note('mic:pcm listener replaced by the alert logger');
    return realOn.call(this, channel, function smokeMicAlertLogger(_e, buf) {
      S.micPcmBlocked++;
      if (S.micPcmBlocked <= 3) alert('mic:pcm arrived (' + (buf && buf.byteLength) + ' bytes) and was DROPPED');
    });
  }
  if (channel === 'system:pcm' && CFG.tracePcm) {
    // Level trace of the meeting audio cue receives (30 ms frame RMS, numbers only).
    note('system:pcm level trace on');
    return realOn.call(this, channel, function smokeSystemPcmTap(e, ab) {
      try {
        const T = S.pcmTrace || (S.pcmTrace = { t0: Date.now(), rms: [], rest: Buffer.alloc(0) });
        const all = Buffer.concat([T.rest, Buffer.from(ab)]);
        let off = 0;
        for (; off + 960 <= all.length && T.rms.length < 6000; off += 960) {
          let sum = 0; for (let i = 0; i < 480; i++) { const s = all.readInt16LE(off + i * 2); sum += s * s; }
          T.rms.push(Math.round(Math.sqrt(sum / 480)));
        }
        T.rest = Buffer.from(all.subarray(off));
      } catch (_) {}
      return listener.apply(this, arguments);
    });
  }
  return realOn.call(this, channel, listener);
};
ipcMain.addListener = ipcMain.on;
// capture:toggle is timestamped (pass-through) so a fault can target the stop flush.
const realHandle = ipcMain.handle;
ipcMain.handle = function (channel, fn) {
  if (channel === 'capture:toggle') {
    return realHandle.call(this, channel, function smokeToggleTimer(...a) { S.toggles.push(Date.now()); return fn.apply(this, a); });
  }
  return realHandle.call(this, channel, fn);
};

// 6. No macOS mic prompt; Chromium mic permission denied; real display capture denied.
if (systemPreferences && process.platform === 'darwin') {
  systemPreferences.askForMediaAccess = async (t) => { S.askForMediaAccess++; alert('askForMediaAccess(' + t + ') blocked'); return false; };
}
app.once('ready', () => {
  const ses = realElectron.session.defaultSession;
  const isMic = (perm, d) => perm === 'microphone' || perm === 'audioCapture' ||
    (perm === 'media' && !(d && ((Array.isArray(d.mediaTypes) && d.mediaTypes.length && !d.mediaTypes.includes('audio')) || d.mediaType === 'video')));
  const oReq = ses.setPermissionRequestHandler.bind(ses);
  const oChk = ses.setPermissionCheckHandler.bind(ses);
  ses.setPermissionRequestHandler = (h) => oReq((wc, perm, cb, d) => {
    if (CFG.denyMic && isMic(perm, d)) { S.micPermDenied++; alert('mic permission request reached the session and was denied: ' + perm); return cb(false); }
    return h ? h(wc, perm, cb, d) : cb(true);
  });
  ses.setPermissionCheckHandler = (h) => oChk((wc, perm, origin, d) => {
    if (CFG.denyMic && isMic(perm, d)) return false;
    return h ? h(wc, perm, origin, d) : true;
  });
  ses.setPermissionRequestHandler(null);
  ses.setPermissionCheckHandler(null);
  if (CFG.denyDisplayMedia) {
    const oDisp = ses.setDisplayMediaRequestHandler.bind(ses);
    ses.setDisplayMediaRequestHandler = (_h, o) => {
      note("cue's display-media handler replaced by deny + alert");
      return oDisp((_req, cb) => { S.displayMediaDenied++; alert('a REAL getDisplayMedia reached main and was denied'); cb(undefined); }, o);
    };
    ses.setDisplayMediaRequestHandler(null);
  }
  note('session permission guards installed');
});

// 7. Renderer stub on every webContents, registered before its first document.
// Every load on this webContents waits until the stub is registered, so the
// first document can never run without it (first try: the load won the race).
app.on('web-contents-created', (_e, wc) => {
  try { wc.debugger.attach('1.3'); } catch (e) { alert('debugger attach failed: ' + e.message); return; }
  // The stub command needs a live renderer, so: about:blank first, then
  // register, then the real page. Fails closed after 15 s.
  const origLoadURL = wc.loadURL.bind(wc);
  let ready = null;
  const ensure = () => ready || (ready = Promise.race([
    (async () => {
      await origLoadURL(CFG.blankUrl || 'about:blank');
      await wc.debugger.sendCommand('Page.enable');
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CFG.rendererStub });
      S.stubbedContents++;
      note('renderer stub registered for webContents ' + wc.id);
    })(),
    new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
  ]).catch((e) => { alert('renderer stub register failed: ' + e.message); throw e; }));
  wc.loadURL = (...a) => ensure().then(
    () => { note('loadURL after stub registration (webContents ' + wc.id + ')'); return origLoadURL(...a); },
    () => { alert('loadURL refused: renderer stub not registered'); throw new Error('renderer stub not registered'); });
});

note('hooks installed (platform ' + process.platform + ')');
return JSON.stringify({ ok: true, platform: process.platform, electron: process.versions.electron });
