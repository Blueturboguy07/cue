// cdp-audio-tap.js — real-sound check of cue's Windows meeting-audio path.
//
// Run against an installed cue.exe started with --remote-debugging-port.
// Over CDP it:
//   1. installs a passive tap in the renderer BEFORE the session starts:
//      - wraps navigator.mediaDevices.getDisplayMedia (cue's own call still
//        goes through; the tap records the result and clones the loopback
//        track into a separate recorder = "raw-loopback"),
//      - wraps AudioWorkletNode so every PCM chunk cue's worklet posts to the
//        page (the bytes cue then hands to window.cue.systemPcm / micPcm) is
//        also copied, tagged "them" (stream from getDisplayMedia) or "you",
//   2. closes first-run onboarding (#ob-skip) like a user,
//   3. clicks "Start session" (#stop-btn) with a real CDP mouse event,
//   4. plays SPEECH_WAV on the default Windows output (System.Media.SoundPlayer),
//   5. dumps the copied PCM to WAV files (16 kHz, 16-bit, mono) and reports
//      RMS / peak for the silent lead-in and for the speech window.
//
// env: CDP_PORT (9222), OUT_DIR (out), SPEECH_WAV (path to the WAV to play)
// Prints one JSON line; writes OUT_DIR/tap-result.json, cue-them.wav,
// cue-you.wav, raw-loopback.wav, cue-before.png, cue-during.png.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || '9222';
const OUT = process.env.OUT_DIR || 'out';
const WAV = process.env.SPEECH_WAV;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
async function findPage() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const p = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url));
      if (p) return p;
    } catch (_) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no cue index page on CDP port ' + PORT);
}

const TAP = `(() => {
  if (window.__tap) return 'tap already installed';
  const tap = window.__tap = { gdm: [], them: [], you: [], raw: [], kinds: new WeakMap(), sysIds: new Set(), notes: [] };
  const md = navigator.mediaDevices;
  const origGdm = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async function (constraints) {
    const rec = { at: Date.now(), constraints: JSON.stringify(constraints) };
    tap.gdm.push(rec);
    try {
      const s = await origGdm(constraints);
      const at = s.getAudioTracks();
      rec.ok = true; rec.audioTracks = at.length; rec.videoTracks = s.getVideoTracks().length;
      rec.audio = at.map((t) => ({ label: t.label, readyState: t.readyState, muted: t.muted, settings: t.getSettings() }));
      at.forEach((t) => tap.sysIds.add(t.id));
      if (at.length) {
        try {
          const ctx = new AudioContext({ sampleRate: 16000 });
          const src = ctx.createMediaStreamSource(new MediaStream([at[0].clone()]));
          const sp = ctx.createScriptProcessor(4096, 1, 1);
          const mute = ctx.createGain(); mute.gain.value = 0;
          sp.onaudioprocess = (e) => {
            const f = e.inputBuffer.getChannelData(0); const o = new Int16Array(f.length);
            for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
            tap.raw.push({ t: Date.now(), b: o.buffer });
          };
          src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
          tap.notes.push('raw tee recorder started on a clone of the loopback track');
        } catch (e) { tap.notes.push('raw tee failed: ' + e.message); }
      }
      return s;
    } catch (e) {
      rec.ok = false; rec.error = (e && e.name) + ': ' + (e && e.message);
      throw e;
    }
  };
  const origCMSS = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    try {
      const isSys = stream.getAudioTracks().some((t) => tap.sysIds.has(t.id));
      if (isSys) tap.kinds.set(this, 'them'); else if (!tap.kinds.has(this)) tap.kinds.set(this, 'you');
    } catch (_) { /* keep going */ }
    return origCMSS.call(this, stream);
  };
  const OrigAWN = window.AudioWorkletNode;
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  function TapAWN(ctx, name, opts) {
    const node = new OrigAWN(ctx, name, opts);
    const port = node.port; let handler = null;
    Object.defineProperty(port, 'onmessage', {
      configurable: true,
      get() { return handler; },
      set(fn) {
        handler = fn;
        desc.set.call(port, function (e) {
          try {
            const kind = tap.kinds.get(ctx) || 'you';
            if (e.data instanceof ArrayBuffer) tap[kind].push({ t: Date.now(), b: e.data.slice(0) });
          } catch (_) { /* keep going */ }
          return fn ? fn.call(this, e) : undefined;
        });
      }
    });
    tap.notes.push('AudioWorkletNode ' + name + ' on a ' + (tap.kinds.get(ctx) || 'you') + ' context');
    return node;
  }
  TapAWN.prototype = OrigAWN.prototype;
  window.AudioWorkletNode = TapAWN;
  return 'tap installed';
})()`;

const DUMP = `(() => {
  const t = window.__tap;
  const enc = (arr) => {
    let n = 0; arr.forEach((c) => { n += c.b.byteLength; });
    const u = new Uint8Array(n); let o = 0;
    arr.forEach((c) => { u.set(new Uint8Array(c.b), o); o += c.b.byteLength; });
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const pack = (arr) => ({ chunks: arr.length, times: arr.map((c) => [c.t, c.b.byteLength]), b64: enc(arr) });
  return JSON.stringify({ gdm: t.gdm, notes: t.notes, them: pack(t.them), you: pack(t.you), raw: pack(t.raw) });
})()`;

function wavHeader(dataBytes, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
// RMS / peak in int16 units (cue's gate is RMS_GATE=180 on the same scale).
function levels(buf) {
  const n = Math.floor(buf.length / 2); if (!n) return { samples: 0, rms: 0, peak: 0 };
  let sum = 0, peak = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
  return { samples: n, seconds: +(n / 16000).toFixed(2), rms: Math.round(Math.sqrt(sum / n)), peak };
}
// Split a channel by chunk arrival time: before playback, during playback (+1 s tail), after.
function windows(ch, playStart, playEnd) {
  const all = Buffer.from(ch.b64, 'base64');
  const parts = { before: [], speech: [], after: [] }; let off = 0;
  for (const [t, len] of ch.times) {
    const b = all.subarray(off, off + len); off += len;
    if (t < playStart) parts.before.push(b); else if (t <= playEnd + 1000) parts.speech.push(b); else parts.after.push(b);
  }
  return { all, total: levels(all), before: levels(Buffer.concat(parts.before)), speech: levels(Buffer.concat(parts.speech)), after: levels(Buffer.concat(parts.after)), chunks: ch.chunks };
}

(async () => {
  const result = { ok: false };
  try {
    const page = await findPage();
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    let id = 0; const pending = new Map(); const consoleLines = [];
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.args.map((a) => a.value).join(' ').slice(0, 300));
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const clickSel = async (sel) => {
      const rect = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || !e.getClientRects().length) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: e.textContent.trim().slice(0, 40) }; })()`);
      if (!rect) return null;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      return rect;
    };
    await send('Runtime.enable');
    await sleep(3000); // let the renderer finish its first render
    result.tap = await evalJs(TAP);

    // Onboarding (first run) covers the toolbar: Skip, like a user.
    const scrimUp = await evalJs(`(() => { const s = document.getElementById('onboard-scrim'); return !!s && !s.classList.contains('hidden') && getComputedStyle(s).display !== 'none'; })()`);
    if (scrimUp) { result.onboardingSkip = await clickSel('#ob-skip'); await sleep(800); }
    await shot('cue-before.png');

    const clickAt = Date.now();
    result.startClick = await clickSel('#stop-btn');
    result.startClickAt = clickAt;
    // Wait for cue's getDisplayMedia to settle and (if it worked) for "them" chunks.
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const s = await evalJs(`JSON.stringify({ g: window.__tap.gdm.map((x) => x.ok), them: window.__tap.them.length })`);
      const p = JSON.parse(s);
      if (p.g.length && (p.g.includes(false) || p.them > 2)) break;
    }
    await sleep(2000); // silent lead-in, for the baseline level

    result.uiAfterStart = JSON.parse(await evalJs(`JSON.stringify({ button: (document.getElementById('stop-btn') || {}).textContent, status: (() => { const e = document.getElementById('cue-status'); return e ? e.textContent.trim().slice(0, 300) : null; })(), sttStatus: (document.getElementById('stt-status') || {}).textContent || null })`));
    await shot('cue-during.png');

    // Play the known sentence on the default output device.
    const playStart = Date.now(); let playError = null;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = New-Object System.Media.SoundPlayer '${path.resolve(WAV)}'; $p.PlaySync()`], { stdio: 'pipe', timeout: 60000 });
    } catch (e) { playError = String(e.stderr || e.message).slice(0, 400); }
    const playEnd = Date.now();
    result.playback = { file: path.basename(WAV), start: playStart, end: playEnd, ms: playEnd - playStart, error: playError };
    await sleep(3000);

    const dump = JSON.parse(await evalJs(DUMP));
    result.getDisplayMedia = dump.gdm;
    result.notes = dump.notes;
    for (const ch of ['them', 'you', 'raw']) {
      const w = windows(dump[ch], playStart, playEnd);
      result[ch] = { chunks: w.chunks, total: w.total, before: w.before, speech: w.speech, after: w.after };
      const name = ch === 'raw' ? 'raw-loopback.wav' : `cue-${ch}.wav`;
      fs.writeFileSync(path.join(OUT, name), Buffer.concat([wavHeader(w.all.length), w.all]));
    }

    // End the session like a user, then read cue's own status line.
    await clickSel('#stop-btn');
    await sleep(1000);
    result.consoleLines = consoleLines.slice(-40);
    const them = result.them;
    result.verdict = !result.getDisplayMedia.length ? 'NO_CAPTURE_REQUEST'
      : result.getDisplayMedia.some((g) => g.ok === false) && !them.chunks ? 'NO_CAPTURE (getDisplayMedia failed)'
        : !them.chunks ? 'NO_CAPTURE (no meeting-audio chunks)'
          : them.speech.rms >= 180 && them.speech.rms > 4 * Math.max(1, them.before.rms) ? 'REAL_SOUND_CAPTURED'
            : 'SILENCE (chunks flow but no speech level)';
    result.ok = true;
    ws.close();
  } catch (e) {
    result.error = String(e && e.stack || e).slice(0, 800);
  }
  fs.writeFileSync(path.join(OUT, 'tap-result.json'), JSON.stringify(result, null, 1));
  const brief = { verdict: result.verdict, gdm: (result.getDisplayMedia || []).map((g) => ({ ok: g.ok, error: g.error, audioTracks: g.audioTracks, labels: (g.audio || []).map((a) => a.label) })), them: result.them && { chunks: result.them.chunks, before: result.them.before, speech: result.them.speech }, raw: result.raw && { chunks: result.raw.chunks, before: result.raw.before, speech: result.raw.speech }, you: result.you && { chunks: result.you.chunks, speech: result.you.speech }, playback: result.playback, ui: result.uiAfterStart, error: result.error };
  console.log(JSON.stringify(brief));
  process.exit(0);
})();
