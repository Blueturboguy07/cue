const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');

let win = null;
let registeredAssistShortcut = null;

const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
const RESERVED_SHORTCUTS = new Set([
  'commandorcontrol+h',
  'commandorcontrol+shift+x'
]);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 3500;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
  } else {
    win.setAlwaysOnTop(true);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
}

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      transcript.push(turn);
      if (DEBUG) console.log(`[TRANSCRIPT] ${channel === 'you' ? 'You' : 'Them'}:`, turn.text);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    startFlushLoop();
  } else {
    stopFlushLoop();
    buffers.you = []; buffers.them = [];
  }
  send('capture:state', { active });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (DEBUG) console.log('[DEBUG MAIN] runFeature called:', { mode, userText, isBusy: state.busy });
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) {
    if (DEBUG) console.log('[DEBUG MAIN] mode not found:', mode);
    return;
  }
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    if (DEBUG) console.log('[DEBUG MAIN] LLM settings loaded:', { provider: settings.provider, smart: settings.smart });
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      if (DEBUG) console.log('[DEBUG MAIN] LLM not ready (missing key or model).');
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try { 
        imageDataUrl = await captureScreenshot(); 
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      }
      catch (e) { 
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('status', { message: 'Screen capture needs permission — grant Screen Recording to cue in System Settings.' }); 
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');
    const fullText = await llm.stream({
      system: def.system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => send('llm:token', { text: t })
    });
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('shortcut:assist:set', (_e, accelerator) => setAssistShortcut(accelerator));
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function normalizeShortcut(accelerator) {
  return typeof accelerator === 'string' ? accelerator.trim().replace(/\s+/g, '') : '';
}

function registerAssistShortcut(accelerator) {
  const next = normalizeShortcut(accelerator) || DEFAULT_ASSIST_SHORTCUT;
  if (next.length > 80) return { ok: false, error: 'That shortcut is too long.' };
  if (RESERVED_SHORTCUTS.has(next.toLowerCase())) {
    return { ok: false, error: 'That shortcut is reserved by another cue action.' };
  }

  const previous = registeredAssistShortcut;
  if (previous) globalShortcut.unregister(previous);

  try {
    if (!globalShortcut.register(next, () => runFeature('assist', ''))) {
      if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
    return { ok: false, error: 'That key combination is not a valid global shortcut.' };
  }

  registeredAssistShortcut = next;
  return { ok: true, accelerator: next };
}

function setAssistShortcut(accelerator) {
  const result = registerAssistShortcut(accelerator);
  if (result.ok) store.setSettings({ shortcuts: { assist: result.accelerator } });
  return result;
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());

  const settings = store.getSettings();
  const configured = settings.shortcuts && settings.shortcuts.assist;
  const result = registerAssistShortcut(configured || DEFAULT_ASSIST_SHORTCUT);
  if (!result.ok && configured && configured !== DEFAULT_ASSIST_SHORTCUT) {
    console.log('[cue] unable to register Assist shortcut:', result.error, 'Falling back to default.');
    const fallback = registerAssistShortcut(DEFAULT_ASSIST_SHORTCUT);
    if (fallback.ok) store.setSettings({ shortcuts: { assist: DEFAULT_ASSIST_SHORTCUT } });
  }
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
