const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./src/store');
const { createCaptureController } = require('./src/capture-controller');
const { abortable } = require('./src/abort');
const { createWindowPrivacy } = require('./src/window-privacy');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { UtteranceBatcher } = require('./src/publik-stt-batcher');
const { parseDocumentFile } = require('./src/resume');
const { createLLM, normalizeProviderName } = require('./src/llm');
const { giveUpTimer } = require('./src/give-up');
const { checkOwnKey } = require('./src/own-key-check');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { isCrossTalkEcho } = require('./src/echo');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');
const publik = require('./src/publik');
// The app token release.yml baked into src/publik-build.json (empty in a dev
// checkout → the publik option is simply absent from the provider picker).
const publikBuild = publik.loadBuildConfig();
const { createMeetingStore } = require('./src/meetings');
const { createMeetingMemory } = require('./src/meeting-memory');
const { createSessionContext } = require('./src/session-context');
const { notesDestination } = require('./src/notes-policy');
const {
  hashRGBA,
  shouldEmitSlide,
  createSlideStore,
  clampSlidesConfig,
  buildSlideSystem,
  buildSlideUser,
  DEFAULT_STABLE_REQUIRED
} = require('./src/slides');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

// Linux Wayland / Ozone native rendering configuration. Without this, Electron
// falls back to XWayland even on a native Wayland session; 'auto' picks Wayland
// when available and X11 otherwise. Harmless no-op on X11-only sessions.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = isWindows && WIN_BUILD >= 19041;

// Preserve the conservative remote-session behavior: applying protection in
// these sessions previously made Cue invisible to the local user too.
const windowPrivacy = createWindowPrivacy({
  platform: process.platform, winBuild: WIN_BUILD,
  sessionName: process.env.SESSIONNAME, noProtect: process.env.CUE_NO_PROTECT
});
let privacyEpoch = new AbortController();
let privacyTransition = Promise.resolve();
let privacyRevision = 0;
if (store.getSettings().privacyPaused === true) {
  windowPrivacy.setPaused(true);
  privacyEpoch.abort();
}

let permWin = null;
// Windows never blocks startup on an unresolved permission (see app.whenReady()
// below), so launchApp() can already have run once by the time the user grants
// access and clicks Continue in the gate window (permissions:continue also
// calls launchApp()). Without this guard the second call re-creates the main
// BrowserWindow (createWindow() has no existing-window check), re-registers
// global shortcuts and re-starts the applink server -- a real, reachable
// regression, not a hypothetical.
let appLaunched = false;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const publikSttBatchers = { you: new UtteranceBatcher(), them: new UtteranceBatcher() };
let publikSttNoticeAt = 0; // last "Transcription paused" notice for a passing publik error
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const sessionContext = createSessionContext(); // files loaded for this meeting; memory-only
let meetingMemory = null; // persists the transcript per meeting + notes; see src/meeting-memory.js
let restoredTurns = []; // turns of an interrupted meeting resumed at launch, replayed to the renderer once
// -------- slides state (memory-only, never written to disk) --------
let slideStore = createSlideStore({ maxSlides: 50 });
let slideTimer = null;
let slideLastHash = null;
let slideStableCount = 0;
let slideBusy = false;
let slideController = null;
let slideDisabled = false; // set when the chat key rejects slide captions (stops cost spam)
let slideTxCursor = 0; // transcript.length at last emitted slide
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const THINKING_PING_MS = 5000; // at most one "Thinking…" signal to the renderer per 5 s
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let stoppingWhisperTranscriber = null;
let activeWhisperModelId = null;
const captureController = createCaptureController({ start: startCapturing, stop: stopCapturing });
function setCapturing(active) {
  if (active === true && windowPrivacy.paused) return Promise.resolve(false);
  if (active === false) cancelFeature();
  return captureController.set(active);
}
const batchRequests = { you: null, them: null };
let featureRequest = null;
function cancelFeature() {
  if (!featureRequest) return;
  featureRequest.abort();
  featureRequest = null;
  state.busy = false;
  send('llm:done', {});
}
function cancelBatch(channel) {
  batchRequests[channel]?.abort();
  batchRequests[channel] = null;
  state.transcribing[channel] = false;
}

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

// Returns false when the turn is the other channel's words echoed back, so callers skip it.
function pushTranscript(turn) {
  if (isCrossTalkEcho(turn, transcript)) return false;
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
  if (meetingMemory) meetingMemory.onTurn(turn);
  return true;
}

function send(channel, data) {
  if (win && !win.isDestroyed()) { try { win.webContents.send(channel, data); } catch (_) {} }
}

function requireOwnedWindow(event) {
  const owned = [win, permWin].find((window) => window && !window.isDestroyed() && window.webContents === event?.sender);
  if (!owned || ('senderFrame' in event && event.senderFrame !== owned.webContents.mainFrame)) {
    throw new Error('This action requires a Cue window.');
  }
  return owned;
}

function requireUnpaused() {
  if (windowPrivacy.paused) throw new Error('Privacy pause is active. Resume explicitly to continue.');
}

function pauseSession() {
  ++privacyRevision;
  if (windowPrivacy.paused) return privacyTransition;
  windowPrivacy.setPaused(true);
  privacyEpoch.abort();
  meetingMemory?.cancelNotes();
  stoppingWhisperTranscriber?.forceStop().catch(() => {});
  cancelFeature();
  cancelBatch('you'); cancelBatch('them');
  stopSlideLoop(); stopFlushLoop(); stopStreamingSTT();
  clearTimeout(publikWalletTimer);
  privacyTransition = setCapturing(false).catch(() => {});
  send('capture:state', { active: false, streaming: false, mode: 'off' });
  windowPrivacy.hide();
  if (whisperModelManager?.activeDownload) {
    try { whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId); } catch (_) {}
  }
  try { store.setSettings({ privacyPaused: true }); } catch (_) {}
  return privacyTransition;
}

async function resumeSession() {
  if (!windowPrivacy.paused) return;
  const revision = ++privacyRevision;
  await privacyTransition;
  if (revision !== privacyRevision) return;
  privacyEpoch = new AbortController();
  try { store.setSettings({ privacyPaused: false }); } catch (_) {}
  windowPrivacy.setPaused(false);
  windowPrivacy.restore();
}

ipcMain.handle('privacy:state', (event) => {
  requireOwnedWindow(event);
  return windowPrivacy.info(event.sender);
});
ipcMain.on('window:ready', (event, token) => {
  try { requireOwnedWindow(event); } catch (_) { return; }
  windowPrivacy.ready(event.sender, token);
});
ipcMain.handle('window:hide', (event) => {
  requireOwnedWindow(event);
  if (!windowPrivacy.hide()) throw new Error('The restore shortcut is unavailable; Cue will stay visible.');
});
ipcMain.handle('privacy:pause', async (event) => {
  requireOwnedWindow(event);
  await pauseSession();
});
ipcMain.handle('privacy:resume', async (event) => {
  requireOwnedWindow(event);
  await resumeSession();
});

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (windowPrivacy.paused) return;
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  if (!pushTranscript(turn)) return;
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings, signal) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    signal.throwIfAborted();
    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
    signal.throwIfAborted();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
// The window has a transparent, click-through strip on each side of the main column so
// the history sidebar can slide out left or right. Must match --main-w/--side-w in
// styles.css. Saved windowX is the main column's x, not the window's.
const MAIN_W = 700, SIDE_W = 300;

function saveWindowPosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  store.setSettings({ windowX: x + SIDE_W, windowY: y });
}

function createWindow() {
  if (win && !win.isDestroyed()) { windowPrivacy.show(win); return; }
  const { workArea } = screen.getPrimaryDisplay();
  const W = SIDE_W + MAIN_W + SIDE_W, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - MAIN_W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - MAIN_W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    // Keep the whole window on screen, not just a 40px sliver of it. The old
    // `- 40` let a 600px-tall window sit at y=607 on a 960px display, pushing
    // the composer and action row off the bottom edge with no way to reach them.
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - H));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    show: false,
    width: W,
    height: H,
    x: startX - SIDE_W,
    y: startY,
    enableLargerThanScreen: true,
    // The window is shown inactive and never takes focus, so without this macOS spends the
    // first click only activating it and a press on the drag handle does nothing.
    acceptFirstMouse: true,
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
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }
  // On macOS, 'panel' makes a non-activating NSPanel: clicking cue no longer
  // activates the app, so a full-screen browser keeps focus instead of firing
  // blur/visibilitychange (which pages answer by exiting full screen or logging).
  if (isMac) {
    winOptions.type = 'panel';
  }

  win = new BrowserWindow(winOptions);
  const ownedWindow = win;

  windowPrivacy.register(win, 'main');

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(saveWindowPosition, 500);
  });

  win.setTitle('Microsoft Edge Update'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.setTitle('Microsoft Edge Update');
    if (restoredTurns.length) {
      // A meeting was in progress when cue last exited: put its transcript back
      // in the sidebar so Recap / Follow-up pick up where the conversation was.
      const turns = restoredTurns;
      restoredTurns = [];
      send('transcript:restore', { turns });
      const ageMin = Math.max(1, Math.round((Date.now() - turns[turns.length - 1].ts) / 60000));
      send('status', { message: `Resumed your meeting from ${ageMin} min ago (${turns.length} turns restored).` });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    setCapturing(false).catch(() => {});
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
  win.webContents.on('did-start-loading', () => { setCapturing(false).catch(() => {}); });
  win.on('closed', () => {
    if (win === ownedWindow) win = null;
    setCapturing(false).catch(() => {});
  });
}

// -------- STT flushing (batch mode fallback) --------
// Said once when listening has no transcription path at all. With publik
// selected and connected, src/stt.js transcribes through publik API, so this
// only shows when publik is not set up (or its key was revoked) or another
// provider without an audio key is selected.
function noTranscriptionMessage(settings) {
  const tail = 'Screen and coding features work without it.';
  if (settings.provider === publik.PUBLIK_PROVIDER) {
    return `Listening needs publik API to be connected. Set it up or press Reconnect in Settings, or choose Local transcription. ${tail}`;
  }
  // publik first: it transcribes with no key of the person's own.
  if (publikBuild.available) {
    return `Transcription is off. Switch to publik in Settings to transcribe with no API key. You can also pick Local in Settings › Audio, or add an OpenAI or Groq key. ${tail}`;
  }
  return `Transcription is off. Pick Local in Settings › Audio to transcribe on this computer with no key, or add an OpenAI or Groq key. ${tail}`;
}

async function flushChannel(channel) {
  const sessionSignal = captureController.signal;
  if (!state.capturing || !sessionSignal || sessionSignal.aborted || state.transcribing[channel]) return;
  if (channel === 'them' && store.getSettings().meetingAudio !== true) return;
  const chunks = buffers[channel];
  buffers[channel] = [];
  const windowPcm = chunks.length ? Buffer.concat(chunks) : null;
  // silence gate: a window that is too short or too quiet is not speech
  const voiced = windowPcm && windowPcm.length >= MIN_BYTES && rms16(windowPcm) >= RMS_GATE ? windowPcm : null;
  const settings = store.getSettings();
  const stt = createSTT(settings);
  if (!stt.providers) stt.providers = [];
  let pcm = voiced;
  if (stt.providers[0] === publik.PUBLIK_PROVIDER) {
    // publik API: whole utterances, so two busy channels stay under the
    // key's 60 requests a minute (src/publik-stt-batcher.js).
    pcm = publikSttBatchers[channel].push(voiced);
  } else {
    publikSttBatchers[channel].reset();
  }
  if (!pcm) return;
  // After publik refused for good (balance used up, a refused request), do
  // not send every utterance again; listening resumes on the next start or
  // a Settings save, which clear sttDisabled.
  if (sttDisabled && stt.providers[0] === publik.PUBLIK_PROVIDER) return;

  const request = batchRequests[channel] = new AbortController();
  const signal = AbortSignal.any([sessionSignal, request.signal]);
  state.transcribing[channel] = true;
  try {
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: noTranscriptionMessage(settings) }); }
      return;
    }
    const res = await abortable(stt.transcribe(pcm, { signal }), signal);
    signal.throwIfAborted();
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      if (pushTranscript(turn)) send('transcript', turn);
    }
  } catch (e) {
    if (signal.aborted) return;
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    if (batchRequests[channel] === request) {
      batchRequests[channel] = null;
      state.transcribing[channel] = false;
    }
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  if (err.provider === publik.PUBLIK_PROVIDER) {
    // publik API: busy (429), unreachable (5xx, network) or a timeout is
    // passing; say so at most once a minute and keep listening. Anything
    // else (balance used up, key revoked, a refused request) stops
    // transcription with the gateway's own sentence and its one button --
    // "update your key" is wrong for a key cue minted.
    const passing = err.status === 429 || !err.status || err.status >= 500;
    if (passing) {
      const now = Date.now();
      if (now - publikSttNoticeAt > 60000) { publikSttNoticeAt = now; send('status', { message: `Transcription paused: ${err.message}` }); }
      return;
    }
    sttDisabled = true;
    send('status', { message: `Transcription stopped: ${err.message}`, action: err.action || null });
    if (err.action) publikHandleErrorAction(err.action);
    return;
  }
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const signal = captureController.signal;
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    if (channel === 'them' && settings.meetingAudio !== true) return;
    let instance = null; // set below; lets the callbacks tell a stale instance from the live one
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        if (signal.aborted || (instance && streamingSTT[ch] !== instance)) return; // stale instance after a stop/start

        const turn = { channel: ch, text, ts: Date.now() };
        if (!pushTranscript(turn)) return;
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        if (signal.aborted || (instance && streamingSTT[ch] !== instance)) return;
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        // A socket torn down by a quick stop/start can still report an error a
        // moment later; acting on it would kill the sessions that replaced it
        // and start the batch loop alongside them (double transcription).
        if (signal.aborted || (instance && streamingSTT[channel] !== instance)) return;
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startFlushLoop();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        if (signal.aborted || (instance && streamingSTT[ch] !== instance)) return;
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      instance = sttInstance.instance;
      streamingMode = true;
      streamingSTT[channel] = instance;
      instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      const instance = streamingSTT[channel];
      streamingSTT[channel] = null;
      try { instance.disconnect(); } catch (_) {}
    }
  });
  streamingMode = false;
}

// -------- slides: auto tracking (opt-in, memory-only) --------
// Cheap hash poll (32px thumbnail) every intervalMs; full-res VLM caption only
// on stable change. Never blocks runFeature (own slideBusy flag). Images are
// never stored — only hash + caption + transcript window.
function getSlidesConfig() {
  return clampSlidesConfig(store.getSettings().slides || {});
}

async function captureHashFrame() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 32, height: 32 }
  });
  if (!sources.length) return null;
  const img = sources[0].thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const bmp = img.toBitmap();
  if (!bmp || !size.width || !size.height) return null;
  return { width: size.width, height: size.height, data: bmp };
}

async function captionSlide(imageDataUrl, transcriptSlice) {
  const llm = createLLM(store.getSettings());
  if (!llm.ready) throw new Error(llm.configurationError || 'Complete the provider settings.');
  // A fixed 25 s total limit (never re-armed). When it gives up, the request
  // is cancelled too, so a long think is not billed for a caption nobody sees.
  const guard = giveUpTimer(STREAM_INACTIVITY_MS, 'slide caption timed out');
  if (slideController?.signal) {
    if (slideController.signal.aborted) guard.abort(slideController.signal.reason);
    else slideController.signal.addEventListener('abort', () => guard.abort(slideController.signal.reason), { once: true });
  }
  try {
    return await Promise.race([
      llm.stream({
        system: buildSlideSystem(),
        turns: [{ role: 'user', text: buildSlideUser(transcriptSlice) }],
        imageDataUrl,
        maxTokens: 300,
        // A caption cut at the cap is trimmed and ends with "…", never with
        // the chat answer's "(Cut off: …)" note.
        lengthCut: 'ellipsis',
        signal: guard.signal,
        onToken: () => {}
      }),
      guard.expired
    ]);
  } finally {
    guard.clear();
  }
}

async function pollSlides() {
  const controller = slideController;
  if (!state.capturing || !controller || controller.signal.aborted || slideBusy || slideDisabled) return;
  const cfg = getSlidesConfig();
  if (!cfg.enabled || slideStore.count() >= cfg.maxSlides) return;
  const signal = controller.signal;
  slideBusy = true;
  try {
    const frame = await abortable(captureHashFrame(), signal);
    signal.throwIfAborted();
    if (!frame) return;
    const newHash = hashRGBA(frame.width, frame.height, frame.data);
    if (!newHash) return;
    const decision = shouldEmitSlide(slideLastHash, newHash, {
      threshold: cfg.threshold,
      stableCount: slideStableCount,
      requiredStable: DEFAULT_STABLE_REQUIRED
    });
    slideStableCount = decision.stableCount;
    if (!decision.emit) return;
    const imageDataUrl = await abortable(captureScreenshot(), signal);
    signal.throwIfAborted();
    if (!imageDataUrl) return;
    const txStart = slideTxCursor;
    const txEnd = transcript.length;
    const slice = transcript.slice(txStart, txEnd).slice(-8);
    const caption = (await captionSlide(imageDataUrl, slice) || '').trim();
    signal.throwIfAborted();
    if (!caption) return;
    slideLastHash = newHash;
    const slide = slideStore.add({ hash: newHash, caption, txStart, txEnd });
    slideTxCursor = txEnd;
    send('slides:update', { count: slideStore.count(), last: slide });
    recordEvent({ level: 'info', event: 'slide_captured', msg: 'slide ' + slideStore.count() + ' captioned' });
  } catch (e) {
    if (signal.aborted) return;
    const msg = (e && e.message) || String(e);
    if (/429|quota|401|403|model_not_found/i.test(msg)) {
      slideDisabled = true;
      send('status', { message: 'Slide captions paused: ' + msg });
    } else {
      console.log('[slides] caption failed', msg);
    }
  } finally {
    if (slideController === controller) slideBusy = false;
  }
}

function startSlideLoop() {
  stopSlideLoop();
  slideController = new AbortController();
  const cfg = getSlidesConfig();
  slideTimer = setInterval(() => { pollSlides().catch(() => {}); }, cfg.intervalMs);
  if (slideTimer.unref) slideTimer.unref();
}

function stopSlideLoop() {
  slideController?.abort();
  slideController = null;
  slideBusy = false;
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
}

function resetSlidesSession() {
  stopSlideLoop();
  if (state.capturing) startSlideLoop();
  slideStore.clear();
  slideLastHash = null;
  slideStableCount = 0;
  slideBusy = false;
  slideDisabled = false;
  slideTxCursor = transcript.length;
}

// -------- audio routing (streaming or batch) --------
// Per-channel level report every few seconds while capturing, so "cue never
// hears me" reports can be told apart: no chunks (capture never reached the
// main process), chunks but rms≈0 (a silent/muted device), or healthy audio
// that the transcriber is dropping.
const AUDIO_LEVEL_LOG_MS = 5000;
const audioLevels = { you: { chunks: 0, peakRms: 0 }, them: { chunks: 0, peakRms: 0 }, lastLog: 0 };
function noteAudioLevel(channel, buf) {
  const lv = audioLevels[channel];
  lv.chunks++;
  if (buf.length >= 2) lv.peakRms = Math.max(lv.peakRms, rms16(buf));
  const now = Date.now();
  if (now - audioLevels.lastLog < AUDIO_LEVEL_LOG_MS) return;
  audioLevels.lastLog = now;
  const fmt = (c) => `${c}: chunks=${audioLevels[c].chunks} peakRms=${Math.round(audioLevels[c].peakRms)}`;
  console.log(`[audio] ${fmt('you')} | ${fmt('them')} (gate=${RMS_GATE}, mode=${localWhisperTranscriber ? 'local' : streamingMode ? 'streaming' : 'batch'})`);
  audioLevels.you = { chunks: 0, peakRms: 0 };
  audioLevels.them = { chunks: 0, peakRms: 0 };
}

function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);
  noteAudioLevel(channel, buf);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function startCapturing(signal) {
  signal.throwIfAborted();
  if (windowPrivacy.paused) return false;
  sttDisabled = false; // reset on re-enable
  const settings = store.getSettings();
  if ((settings.sttProvider || 'auto') === 'local') {
    try {
      await startLocalWhisper(settings, signal);
      signal.throwIfAborted();
      state.capturing = true;
      console.log('[cue] capture started, mode: local');
      slideDisabled = false;
      slideTxCursor = transcript.length;
      slideStore = createSlideStore({ maxSlides: getSlidesConfig().maxSlides });
      slideLastHash = null;
      slideStableCount = 0;
      startSlideLoop();
      send('capture:state', { active: true, streaming: false, mode: 'local' });
      send('slides:update', { count: 0, last: null });
      return true;
    } catch (error) {
      state.capturing = false;
      if (signal.aborted) return false;
      if (error.code === 'STARTUP_CANCELLED') {
        send('stt:status', { provider: 'local', status: 'off' });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
      send('stt:status', { provider: 'local', status: 'error' });
      send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
      send('capture:state', { active: false, streaming: false, mode: 'local' });
      return false;
    }
  }

  state.capturing = true;
  // Try streaming first, fall back to batch
  const streaming = initStreamingSTT();
  if (!streaming) {
    startFlushLoop();
  }
  slideDisabled = false;
  slideTxCursor = transcript.length;
  const slideCfg = getSlidesConfig();
  slideStore = createSlideStore({ maxSlides: slideCfg.maxSlides });
  slideLastHash = null;
  slideStableCount = 0;
  startSlideLoop();
  console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
  send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
  send('slides:update', { count: 0, last: null });
  return true;
}

async function stopCapturing() {
  const wasCapturing = state.capturing;
  state.capturing = false;
  cancelFeature();
  cancelBatch('you'); cancelBatch('them');
  stopFlushLoop();
  stopStreamingSTT();
  if (meetingMemory) {
    meetingMemory.cancelNotes();
    // Write/refresh the notes for this meeting in the background so the
    // summary survives even if cue is closed before the meeting formally ends.
    if (!windowPrivacy.paused) meetingMemory.refreshNotes().then((notes) => {
      if (notes) send('status', { message: `Meeting notes saved (${transcript.length} turns).` });
    }).catch(() => {});
  }
  stopSlideLoop();
  buffers.you = []; buffers.them = [];
  publikSttBatchers.you.reset(); publikSttBatchers.them.reset();
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  stoppingWhisperTranscriber = stoppingLocalTranscriber;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      if (wasCapturing && !windowPrivacy.paused) await stoppingLocalTranscriber.stop();
      else await stoppingLocalTranscriber.forceStop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      if (stoppingWhisperTranscriber === stoppingLocalTranscriber) stoppingWhisperTranscriber = null;
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (windowPrivacy.paused) return;
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  const request = featureRequest = new AbortController();
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    // null unless context mode is on AND this question is about the loaded files.
    const ctxDocs = settings.contextMode ? sessionContext.forQuestion({ mode, transcript, userText, webSearch: llm.webSearch }) : null;
    send('llm:start', { userBubble, small: !!def.small, category, context: ctxDocs ? ctxDocs.files : null });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      if (settings.provider === publik.PUBLIK_PROVIDER) {
        // No key yet: either the disclosure was never accepted (open it — the
        // mint happens only on "Sign in with publik"), or the install was
        // revoked or the last mint failed (offer Reconnect, and say why in
        // plain words). The message and its one button always agree. The app
        // never silently spends.
        send('llm:error', publik.notReadyMessage(publikState()));
        return;
      }
      // An own provider with no key, in a build that has publik: publik
      // first, the provider's proper name, one button that switches.
      send('llm:error', publikBuild.available
        ? { message: publik.ownProviderNotReadyMessage({ providerName: llm.providerName, missingKey: llm.missingKey, configurationError: message }), action: { kind: 'switch' } }
        : { message });
      return;
    }
    // Never a silent starter (CONTRACT §12.4): the first-run card — balance,
    // justification, "Link this computer & pick a plan" / "Later" — is shown
    // at least once before any starter usage is spent. Normally it appears
    // right after provisioning; this gate catches a card that was never
    // acknowledged (e.g. an install provisioned by an earlier release).
    if (settings.provider === publik.PUBLIK_PROVIDER && settings.apiKeys.publik && !settings.publik.cardShown) {
      send('llm:error', { message: 'publik API is set up. Take a look at the card, then ask again.', action: { kind: 'card' } });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await abortable(captureScreenshot(), request.signal);
        request.signal.throwIfAborted();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        request.signal.throwIfAborted();
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        const message = process.platform === 'darwin'
          ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
          : process.platform === 'win32'
            ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
            : 'Screen capture failed. Check your desktop capture permissions, then try again.';
        send('status', { message });
      }
    }

    // Follow-up / Recap have nothing to work with before anything was heard —
    // sent to the model anyway, it fabricates plausible generic output that
    // looks like a canned preset. Say so instead, and log how much context
    // every feature actually ran with.
    console.log(`[llm] mode=${mode} transcriptTurns=${transcript.length} capturing=${state.capturing}`);
    if (def.transcriptRequired && transcript.length === 0) {
      send('llm:error', { message: state.capturing
        ? 'Nothing has been transcribed yet — say something (or let the other side talk) and try again.'
        : 'Nothing captured yet — press the listen button first so cue can hear the conversation.' });
      return;
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = [buildInterviewContext(settingsForPrompt, mode, transcript), ctxDocs && ctxDocs.block].filter(Boolean).join('\n\n') || null;
    const system = def.buildSystem ? def.buildSystem(contextBlock, settingsForPrompt.aiRules || '') : (def.system || '');
    const built = def.build({ transcript, userText: userText || '' });

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    // When it gives up, the HTTP request is cancelled too (guard.signal), so the
    // provider stops generating and billing an answer cue no longer shows.
    const guard = giveUpTimer(STREAM_INACTIVITY_MS, 'the model stopped responding (timed out). Please try again.');
    request.signal.addEventListener('abort', () => { streamSettled = true; guard.abort(request.signal.reason); }, { once: true });
    const rearm = guard.rearm;
    // A reasoning model streams its thinking before any text: that is
    // activity too, so a long think is not called a stalled stream. While it
    // only thinks, the renderer shows "Thinking…" (never the reasoning text).
    // The signal repeats at most every 5 s, which keeps the renderer's busy
    // failsafe from firing during a long think.
    let answerStarted = false;
    let thinkingSentAt = 0;
    const noteActivity = (kind) => {
      if (streamSettled) return;
      rearm();
      if (kind === 'thinking' && !answerStarted && Date.now() - thinkingSentAt >= THINKING_PING_MS) {
        thinkingSentAt = Date.now();
        send('llm:thinking', {});
      }
    };
    try {
      await Promise.race([
        llm.stream({
          system,
          turns: [{ role: 'user', text: built }],
          imageDataUrl,
          webSearch: !!(ctxDocs && ctxDocs.webSearch),
          onToken: (t) => { if (streamSettled) return; answerStarted = true; rearm(); send('llm:token', { text: t }); },
          onActivity: noteActivity,
          signal: guard.signal,
          onResponse: settings.provider === publik.PUBLIK_PROVIDER ? (res) => { if (!guard.signal.aborted) publikNoteHeaders(res && res.headers); } : undefined
        }),
        guard.expired
      ]);
    } finally {
      streamSettled = true;
      guard.clear();
    }
    send('llm:done', {});
    // The own key answered: it is not bad (any more).
    clearOwnKeyFailed(settings.provider);
    // Streams settle after their headers, so the charge is reconciled from
    // GET /wallet shortly after the answer — one request per answer, debounced.
    if (settings.provider === publik.PUBLIK_PROVIDER) publikScheduleWalletRefresh();
  } catch (e) {
    if (featureRequest !== request) return;
    recordEvent({ level: 'error', event: e && e.emptyAnswer ? 'llm_empty_answer' : 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider, finishReason: (e && e.finishReason) || null } });
    // A bad own key: plain words, "Switch to publik" first, "Fix my key"
    // second; never the provider's raw 401.
    if (e && e.ownKeyFailed) {
      markOwnKeyFailed(e.ownKeyFailed.provider);
      send('llm:error', publik.ownKeyFailedMessage({ providerName: e.ownKeyFailed.providerName, publikAvailable: publikBuild.available }));
      return;
    }
    const action = e && e.action ? e.action : null;
    send('llm:error', { message: e && e.message ? e.message : String(e), action });
    if (action) publikHandleErrorAction(action);
  } finally {
    streamSettled = true;
    if (featureRequest === request) { featureRequest = null; state.busy = false; }
  }
}

// -------- IPC --------
// Redact on the way out, strip on the way in: the publik key never enters the
// renderer, and the renderer's whole-object Save can never clobber it.
ipcMain.handle('settings:get', () => store.redactForRenderer(store.getSettings()));
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const before = store.getSettings();
  const beforeProvider = before.provider;
  const beforeKey = (before.apiKeys || {})[beforeProvider];
  const meetingAudioWasEnabled = before.meetingAudio === true;
  const previousNotesDestination = notesDestination(before);
  const previousSlides = JSON.stringify(before.slides || {});
  const next = store.setSettings(store.stripRendererPatch(patch));
  if (previousNotesDestination !== notesDestination(next)) meetingMemory?.cancelNotes();
  // After "Fix my key" (or another provider): a refused key that is no
  // longer selected stops counting, and a new own key gets the same free
  // check as at startup.
  const nextKey = (next.apiKeys || {})[next.provider];
  if (next.provider !== beforeProvider || nextKey !== beforeKey) {
    if (ownKeyFailure && !ownKeyFailedFor(next)) { ownKeyFailure = null; publikPush(); }
    checkSelectedOwnKey();
  }
  // Restart slide polling with the new interval when capturing (keeps slides).
  if (next.meetingAudio !== true) { buffers.them = []; cancelBatch('them'); }
  if (state.capturing && !localWhisperTranscriber && meetingAudioWasEnabled !== (next.meetingAudio === true)) {
    stopStreamingSTT(); stopFlushLoop();
    if (!initStreamingSTT()) startFlushLoop();
  }
  send('meeting-audio:state', { enabled: next.meetingAudio === true });
  if (state.capturing && previousSlides !== JSON.stringify(next.slides || {})) startSlideLoop();
  return store.redactForRenderer(next);
});

// -------- publik API --------
// Contract: ~/publik-api-research/CONTRACT.md. The key is minted only after
// the disclosure is accepted (publik:accept-disclosure); the balance line is
// fed by the x-publik-* headers on every answer and reconciled from GET /wallet.
let publikWalletTimer = null;
let publikProvisioning = null;

// -------- a bad own key (0.2.4/0.2.5 users with a home-made OpenAI key) --------
// In memory only: the provider and a short hash of the key it refused, never
// the key. It counts while the same provider and key are selected, so a new
// key or another provider clears it by itself.
let ownKeyFailure = null;
function ownKeyHash(key) { return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16); }
function ownKeyFailedFor(settings) {
  if (!ownKeyFailure || !settings || settings.provider !== ownKeyFailure.provider) return null;
  const key = (settings.apiKeys || {})[ownKeyFailure.provider];
  if (!key || ownKeyHash(key) !== ownKeyFailure.keyHash) return null;
  return { provider: ownKeyFailure.provider, providerName: normalizeProviderName(ownKeyFailure.provider) };
}
function markOwnKeyFailed(provider) {
  const key = (store.getSettings().apiKeys || {})[provider];
  if (!key || provider === publik.PUBLIK_PROVIDER) return;
  ownKeyFailure = { provider, keyHash: ownKeyHash(key) };
  publikPush();
}
function clearOwnKeyFailed(provider) {
  if (!ownKeyFailure || ownKeyFailure.provider !== provider) return;
  ownKeyFailure = null;
  publikPush();
}

// Startup, no paid call: (1) a publik key that was revoked on the dashboard
// while cue was closed shows Reconnect at once (GET /wallet marks it), not
// "Connected" until the first question fails; (2) an own provider key is
// checked with the provider's free "list models" call.
function startupChecks() {
  const s = store.getSettings();
  if (publikBuild.available && s.apiKeys.publik && !s.publik.revoked) {
    publikRefreshWallet().catch(() => {});
  }
  checkSelectedOwnKey();
}
function checkSelectedOwnKey() {
  const s = store.getSettings();
  const provider = s.provider;
  const key = (s.apiKeys || {})[provider];
  if (!provider || provider === publik.PUBLIK_PROVIDER || !key) return;
  checkOwnKey({ provider, apiKey: key }).then((verdict) => {
    recordEvent({ level: 'info', event: 'own_key_checked', msg: verdict, frame: 'checkSelectedOwnKey', context: { provider } });
    // Only if the same key is still selected when the answer comes back.
    const now = store.getSettings();
    if (verdict === 'bad' && now.provider === provider && now.apiKeys[provider] === key) markOwnKeyFailed(provider);
  }).catch(() => {});
}

function publikDevice() {
  let deviceName = '';
  try { deviceName = os.hostname(); } catch { /* optional */ }
  return { appVersion: app.getVersion(), platform: process.platform, osVersion: os.release(), arch: process.arch, deviceName };
}

function publikState() {
  const s = store.getSettings();
  const p = s.publik || {};
  const connected = !!s.apiKeys.publik;
  const wallet = p.wallet || null;
  const claimState = (wallet && wallet.claimState) || p.claimState || 'anonymous';
  const view = {
    available: publikBuild.available,
    selected: s.provider === publik.PUBLIK_PROVIDER,
    connected,
    revoked: !!p.revoked,
    disconnected: !!p.disconnected,
    keyId: p.keyId || '',
    claimState,
    claimUrl: p.claimUrl || (wallet && wallet.claimUrl) || '',
    addCreditUrl: (wallet && wallet.addCreditUrl) || '',
    topUpUrl: (wallet && wallet.topUpUrl) || p.claimUrl || '',
    starterMicros: p.starterMicros || 0,
    balanceMicros: p.balanceMicros,
    balanceAt: p.balanceAt || 0,
    balanceLabel: publik.formatMicros(p.balanceMicros),
    wallet,
    disclosureAccepted: p.disclosureAccepted || 0,
    disclosureVersion: publikBuild.disclosureVersion,
    lastError: p.lastError || '',
    // The failure in plain words (never "fetch failed"); the raw text stays in lastError.
    problem: publik.plainProblem(p),
    // True when the last mint failed (offline, rate limited, server error),
    // as opposed to a gateway sentence such as a revoke. A failed Reconnect
    // also sets `revoked`, and the failure is still the thing to say.
    setupFailed: !!(p.lastError && p.lastErrorKind),
    // An own provider refused its key (on a question or at startup):
    // { provider, providerName } or null. Drives "Switch to publik" first.
    ownKeyFailed: ownKeyFailedFor(s),
    cardShown: !!p.cardShown,
    copy: publik.COPY,
    links: publik.LINKS
  };
  view.line = publik.balanceLine(view);
  // The status sentence on the settings card (the gateway's last answer wins
  // over the fixed revoked/disconnected copy), computed here so the renderer
  // only paints.
  view.status = publik.statusLine(view);
  // CONTRACT §12: the first-run card (shown while connected && !cardShown),
  // the settings button, and the low-starter banner — all computed here so
  // the renderer only paints.
  view.card = publik.ctaView(view);
  view.settingsCta = publik.settingsCta(view);
  view.lowStarter = publik.lowStarterNotice(view);
  return view;
}
function publikPush() { send('publik:state', publikState()); }

async function publikProvision() {
  if (windowPrivacy.paused) return publikState();
  const signal = privacyEpoch.signal;
  if (publikProvisioning) return publikProvisioning;
  publikProvisioning = publik.provisionInstall({
    build: publikBuild,
    store,
    device: publikDevice(),
    signal,
    log: (e) => recordEvent({ level: e.level, event: e.event, msg: e.msg, frame: 'publikProvision', context: e.context || {} })
  }).then((r) => {
    if (signal.aborted) return publikState();
    if (r.ok && r.minted) store.setPublik({ disconnected: false });
    publikPush();
    return publikState();
  }).finally(() => { publikProvisioning = null; });
  return publikProvisioning;
}

// x-publik-* headers from a streamed answer: the balance after admission
// (the hold is included), the claim state, the week. Settlement follows.
function publikNoteHeaders(headers) {
  const h = publik.readGatewayHeaders(headers);
  if (!h) return;
  const s = store.getSettings();
  const wallet = { ...(s.publik.wallet || {}) };
  if (h.balanceMicros !== null) wallet.balanceMicros = h.balanceMicros;
  if (h.claimState) wallet.claimState = h.claimState;
  if (h.weekUsedMicros !== null) wallet.weekUsedMicros = h.weekUsedMicros;
  if (h.weekBudgetMicros !== null || h.weekResetsAt) wallet.weekBudgetMicros = h.weekBudgetMicros;
  if (h.weekResetsAt) wallet.weekResetsAt = h.weekResetsAt;
  if (h.starterRemainingMicros !== null) wallet.starterRemainingMicros = h.starterRemainingMicros;
  store.setPublik({
    balanceMicros: h.balanceMicros !== null ? h.balanceMicros : s.publik.balanceMicros,
    balanceAt: Date.now(),
    claimState: h.claimState || s.publik.claimState,
    wallet,
    revoked: false
  });
  publikPush();
}

async function publikRefreshWallet() {
  if (typeof windowPrivacy !== 'undefined' && windowPrivacy.paused) return publikState();
  const signal = typeof privacyEpoch !== 'undefined' ? privacyEpoch.signal : undefined;
  const s = store.getSettings();
  if (!s.apiKeys.publik) return publikState();
  try {
    const w = await publik.fetchWallet({ baseUrl: s.publik.baseUrl || publikBuild.baseUrl, apiKey: s.apiKeys.publik, signal });
    signal?.throwIfAborted();
    store.setPublik({
      wallet: w, balanceMicros: w.balanceMicros, balanceAt: Date.now(), claimState: w.claimState,
      claimUrl: w.claimUrl || (w.claimState === 'claimed' ? '' : s.publik.claimUrl), revoked: false, disconnected: false, lastError: ''
    });
  } catch (e) {
    if (signal?.aborted) return publikState();
    if (e.status === 401) publikHandleRevoked(e);
    else recordEvent({ level: 'warn', event: 'publik_wallet_failed', msg: e.message, frame: 'publikRefreshWallet', context: { status: e.status || null } });
  }
  publikPush();
  return publikState();
}
function publikScheduleWalletRefresh() {
  if (windowPrivacy.paused) return;
  clearTimeout(publikWalletTimer);
  publikWalletTimer = setTimeout(() => { publikRefreshWallet().catch(() => {}); }, 1500);
}

// 401 key_revoked: reprovision:true (idle sweep) → re-mint on our own with the
// same install_id; reprovision:false (removed from the dashboard) → stay
// disconnected until the user presses Reconnect.
function publikHandleRevoked(e) {
  const revokedType = !!(e && e.type === 'key_revoked');
  const silent = revokedType && e.reprovision === true;
  // "disconnected" is the dashboard/uninstaller removal only; a plain 401
  // (invalid_api_key) just asks for Reconnect.
  store.setPublik({ revoked: true, disconnected: revokedType && !silent, lastError: '' });
  if (silent) publikProvision().catch(() => {});
}
function publikHandleErrorAction(action) {
  if (!action) return;
  if (action.kind === 'reprovision') {
    publikHandleRevoked({ type: 'key_revoked', reprovision: true });
    return;
  }
  // A 401 on a question (or a transcription): the key on disk is dead. Mark
  // it now, so Settings shows Reconnect and the first Reconnect press mints.
  if (action.kind === 'reconnect' && action.revoked) {
    const s = store.getSettings();
    if (!s.apiKeys.publik || s.publik.revoked) return;
    publikHandleRevoked({ type: action.revoked === 'key_revoked' ? 'key_revoked' : 'invalid_api_key', reprovision: false });
    publikPush();
  }
}

ipcMain.handle('publik:state', () => publikState());
ipcMain.handle('publik:accept-disclosure', async () => {
  // Consent precedes mint: this is the only path that calls POST /installs
  // for a fresh install. It also selects publik if the user had moved away.
  requireUnpaused();
  if (!publikBuild.available) return publikState();
  store.setPublik({ disclosureAccepted: publikBuild.disclosureVersion });
  store.setSettings({ provider: publik.PUBLIK_PROVIDER });
  return publikProvision();
});
// One press reconnects: a wallet read that finds the key revoked goes on to
// mint in the same press (src/publik.js reconnectInstall).
ipcMain.handle('publik:reconnect', () => publik.reconnectInstall({
  store, refreshWallet: publikRefreshWallet, provision: publikProvision, state: publikState
}));
ipcMain.handle('publik:refresh', () => publikRefreshWallet());
ipcMain.handle('publik:disconnect', async () => {
  const s = store.getSettings();
  if (s.apiKeys.publik && !windowPrivacy.paused) {
    const signal = privacyEpoch.signal;
    try { await publik.revokeInstall({ baseUrl: s.publik.baseUrl || publikBuild.baseUrl, apiKey: s.apiKeys.publik, signal }); } catch (e) { /* the key is dropped locally regardless */ }
  }
  store.setPublik({ apiKey: '', keyId: '', revoked: false, disconnected: true, balanceMicros: null, wallet: null, lastError: '' });
  publikPush();
  return publikState();
});
// "Later" or the primary button on the first-run card: the card was shown for
// this starter grant. Touches publik.cardShown only — the key stays in place
// and the balance is kept (§12.1).
ipcMain.handle('publik:card-seen', () => {
  try { publik.markCardSeen(store); } catch (e) { recordEvent({ level: 'error', event: 'publik_card_seen_failed', msg: e.message, frame: 'publik:card-seen', context: {} }); }
  publikPush();
  return publikState();
});
// The only path a gateway-supplied URL can take out of the app: publikhq.com
// only. A link off that origin is dropped (the stored claim link stands in
// when it is safe); nothing else is ever handed to the system browser.
ipcMain.on('publik:open', (_e, url) => {
  if (windowPrivacy.paused) return;
  const s = store.getSettings();
  const target = publik.resolveOpenTarget(url, s.publik.claimUrl);
  if (!target) { recordEvent({ level: 'warn', event: 'publik_open_dropped', msg: '', frame: 'publik:open', context: {} }); return; }
  shell.openExternal(target).catch(() => {});
});
ipcMain.handle('capture:set', (_event, active) => setCapturing(active));
ipcMain.handle('capture:toggle', () => setCapturing(!captureController.desired));
ipcMain.handle('capture:state', () => ({ active: state.capturing, desired: captureController.desired }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  requireUnpaused();
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  requireUnpaused();
  const signal = privacyEpoch.signal;
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  signal.throwIfAborted();
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION,
  protection: windowPrivacy.info(win?.webContents).protection
}));
ipcMain.handle('transcript:clear', () => {
  if (meetingMemory) {
    meetingMemory.cancelNotes();
    meetingMemory.end({ writeNotes: false }).catch(() => {});
  } // Clearing keeps local history without starting a provider request.
  transcript.splice(0, transcript.length);
  sessionContext.clear(); // the loaded files belong to the meeting being cleared
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  return { ok: true };
});
ipcMain.handle('slides:list', () => slideStore.list());
ipcMain.handle('slides:state', () => ({
  ...getSlidesConfig(),
  count: slideStore.count(),
  polling: !!slideTimer,
  disabled: slideDisabled
}));
ipcMain.handle('slides:clear', () => {
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing && store.getSettings().meetingAudio === true) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
// Window dragging is done here rather than with CSS drag regions, which misbehave while the
// renderer toggles click-through. The window follows the cursor until the renderer says stop.
let windowDrag = null;
ipcMain.on('window:drag-start', () => {
  if (!win || win.isDestroyed()) return;
  stopWindowDrag();
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const offsetX = cursor.x - bounds.x, offsetY = cursor.y - bounds.y;
  windowDrag = setInterval(() => {
    if (!win || win.isDestroyed()) { stopWindowDrag(); return; }
    const { x, y } = screen.getCursorScreenPoint();
    // setBounds with a fixed size: setPosition can resize the window when crossing mixed-DPI displays on Windows.
    win.setBounds({ x: x - offsetX, y: y - offsetY, width: bounds.width, height: bounds.height });
  }, 16);
});
ipcMain.on('window:drag-end', () => {
  if (!windowDrag) return;
  stopWindowDrag();
  saveWindowPosition();
});
function stopWindowDrag() {
  clearInterval(windowDrag);
  windowDrag = null;
}
ipcMain.on('open-pane', (_e, url) => { if (windowPrivacy.paused) return; shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  requireUnpaused();
  const signal = privacyEpoch.signal;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  signal.throwIfAborted();
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  signal.throwIfAborted();
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
// -------- session context files (context mode) --------
// Same rule as the résumé import: the dialog runs in MAIN, the renderer never supplies a path.
const CONTEXT_FILE_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml'] },
  { name: 'All files', extensions: ['*'] }
];
ipcMain.handle('context:list', () => sessionContext.list());
ipcMain.handle('context:remove', (_e, id) => { sessionContext.remove(id); return sessionContext.list(); });
ipcMain.handle('context:pick', async () => {
  const errors = [];
  try {
    requireUnpaused();
    const signal = privacyEpoch.signal;
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: CONTEXT_FILE_FILTERS });
    signal.throwIfAborted();
    for (const filePath of res.canceled ? [] : res.filePaths) {
      const name = path.basename(filePath);
      try {
        const text = await parseDocumentFile(filePath);
        signal.throwIfAborted();
        sessionContext.add(name, text);
      } catch (e) {
        if (signal.aborted) throw e;
        errors.push({ name, message: (e && e.message) || String(e) });
      }
    }
  } catch (e) {
    errors.push({ name: '', message: (e && e.message) || String(e) });
  }
  return { files: sessionContext.list(), errors };
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => {
  // Forgetting a caller also clears its separate slide-caption consent decision,
  // so a caller the user re-approves later is asked about slides again too,
  // rather than silently inheriting whatever it was granted or denied before.
  store.clearSlidesConsent(callerId);
  return revokeAppLinkCaller(callerId);
});

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.say = globalShortcut.register('CommandOrControl+Return', () => runFeature('say', ''));
  shortcutState.assist = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('assist', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.hide = globalShortcut.register('CommandOrControl+Shift+/', () => send('hide:toggle', {}));
  registerRestoreShortcut();
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

function registerRestoreShortcut() {
  if (shortcutState.restore) return;
  shortcutState.restore = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (windowPrivacy.hidden) windowPrivacy.restore();
    else windowPrivacy.hide();
  });
  windowPrivacy.setRecoverable(shortcutState.restore);
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (windowPrivacy.paused) return sysStatus;
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  // systemPreferences.getMediaAccessStatus('microphone') is also implemented on
  // Windows (it reads the Settings > Privacy > Microphone toggle); 'screen' has
  // no per-app gate on Windows so verifyScreenAccess() falls straight through to
  // 'granted' there. Only genuinely ungated platforms (e.g. Linux) keep the old
  // hard-coded "granted" fallback.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return {
      mic: systemPreferences.getMediaAccessStatus('microphone'),
      screen: await verifyScreenAccess(),
    };
  }
  return { mic: 'granted', screen: 'granted' };
}

async function requestPermissions() {
  requireUnpaused();
  if (process.platform !== 'darwin' && process.platform !== 'win32') return true;

  if (process.platform === 'darwin') {
    // Trigger the macOS microphone permission dialog (first-use only)
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }

    // Trigger the macOS screen-recording permission dialog (first-use only).
    // There is no askForMediaAccess('screen'), but attempting to enumerate
    // sources via desktopCapturer will cause macOS to prompt the user.
    const screenStatus = await verifyScreenAccess();
    if (screenStatus !== 'granted') {
      try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
    }
  }
  // Windows has no OS-level "ask" dialog (systemPreferences.askForMediaAccess is
  // macOS-only) — mic access is governed entirely by the Settings toggle the user
  // flips themselves, which getPermissionStatus() below reads directly.

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  if (permWin && !permWin.isDestroyed()) { windowPrivacy.show(permWin); return; }
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  windowPrivacy.register(permWin, 'permissions');
  const permissionsWindow = permWin;
  permWin.on('closed', () => { if (permWin === permissionsWindow) permWin = null; });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (appLaunched) {
    // Already launched once (Windows startup runs launchApp() unconditionally
    // even while the permission gate is still showing). Just dismiss the gate
    // and bring the existing main window forward instead of building a second
    // one on top of it.
    if (permWin && !permWin.isDestroyed()) { permWin.close(); permWin = null; }
    if (win && !win.isDestroyed()) { windowPrivacy.show(win); }
    return;
  }
  appLaunched = true;

  if (isMac && app.dock) app.dock.hide();

  // Before the app-link snapshot and before the window exists, so a first run
  // boots with provider 'publik'. Runs once per settings file and never moves
  // a user who has a working key. No network call happens here.
  if (store.applyPublikDefault(publikBuild)) {
    recordEvent({ level: 'info', event: 'publik_default_applied', msg: '', frame: 'launchApp', context: {} });
  }

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  meetingMemory = createMeetingMemory({
    store: createMeetingStore({ file: path.join(app.getPath('userData'), 'meetings.json'), debounceMs: 1500 }),
    llmFactory: () => createLLM(store.getSettings()),
    getNotesDestination: () => windowPrivacy.paused ? null : notesDestination(store.getSettings()),
    log: (msg) => console.log('[meetings]', msg)
  });
  restoredTurns = meetingMemory.resumeOpen();
  if (restoredTurns.length) transcript.push(...restoredTurns.slice(-MAX_TRANSCRIPT_TURNS));
  meetingMemory.catchUp().then((n) => { if (n) console.log(`[meetings] wrote notes for ${n} earlier meeting(s)`); }).catch(() => {});

  const allowMedia = (permission) => !windowPrivacy.paused && ['media', 'microphone', 'audioCapture', 'display-capture', 'screen'].includes(permission);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  //
  // Two things are true here and both must hold.
  //
  // 1. `audio` must be the string 'loopback' or 'loopbackWithMute' (or a WebFrameMain).
  // Electron's native binding for this callback rejects anything else, including a
  // plain boolean. Windows used to get `true`, which threw synchronously and surfaced
  // to the renderer as AbortError "Error starting capture" ("Meeting audio could not be
  // started"), and also invoked this one-time `callback` a SECOND time. Never pass a
  // boolean on any platform, and invoke `callback` from exactly one place.
  //
  // 2. Meeting audio Off denies grants on every platform. On macOS the grant is not free: the only route to system audio is a
  // ScreenCaptureKit session over a real display, so while it is held open macOS paints
  // its screen-recording indicator and names cue under Control Center's "Currently
  // Sharing" — pixels every screen-share viewer sees. Nothing app-side suppresses it
  // (an audio-only grant is rejected by Chromium; a window source lights the same
  // indicator), so the honest answer is consent: never open that session on macOS
  // unless the user switched Meeting audio on in Settings > Audio. This guard is the
  // enforcement point and holds even if another renderer path calls getDisplayMedia.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // The consent gate resolves to an empty source list instead of invoking the
    // one-time reply itself, so this handler keeps exactly one invocation site.
    // test/display-media-audio.test.js counts them, because a second site is how the
    // "One-time callback was called more than once" bug happened before.
    const signal = captureController.signal;
    const allowed = store.getSettings().meetingAudio === true && !!signal && !signal.aborted;
    (allowed ? desktopCapturer.getSources({ types: ['screen'] }) : Promise.resolve([]))
      .then((sources) => (sources.length && !signal.aborted && store.getSettings().meetingAudio === true
        ? { video: sources[0], audio: 'loopback' } : undefined))
      .catch((err) => {
        console.error('[main] system audio: desktopCapturer.getSources failed:', err);
        return undefined;
      })
      .then((request) => callback(request));
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
      slides: slideStore.list(),
    }),
    setCapturing,
    getSlides: () => slideStore.list(),
    getSlidesConsent: (callerId) => store.getSlidesConsent(callerId),
    setSlidesConsent: (callerId, decision) => store.setSlidesConsent(callerId, decision),
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
    canPrompt: () => windowPrivacy.canPrompt(win),
    privacySignal: () => privacyEpoch.signal,
  });

  createWindow();
  registerShortcuts();
  startupChecks();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  registerRestoreShortcut();
  app.setName('MicrosoftEdgeUpdate');
  if (isWindows) {
    process.title = 'MicrosoftEdgeUpdate';
  }

  if (windowPrivacy.paused) {
    launchApp();
    app.on('activate', () => windowPrivacy.restore());
    return;
  }

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  } else if (isWindows) {
    // Windows has no OS-level modal permission dialog to block startup on —
    // there is no askForMediaAccess() equivalent, and the only way to change
    // the mic toggle is to leave the app and use Settings — so unlike macOS
    // this never withholds the main window. It surfaces the same in-app
    // gate as an informational window alongside the app instead of leaving
    // the user with no option at all to see or act on the permission state
    // ("not able to give permission ... coz there is no option").
    const allGranted = await requestPermissions();
    if (!allGranted) {
      createPermissionsWindow();
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); windowPrivacy.restore(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  privacyEpoch.abort();
  clearTimeout(publikWalletTimer);
  const quittingTranscriber = localWhisperTranscriber || stoppingWhisperTranscriber;
  // Keep the meeting open for an explicit, consented resumption.
  meetingMemory?.cancelNotes();
  if (meetingMemory) meetingMemory.flush();
  meetingMemory = null;
  setCapturing(false).catch(() => {});
  cancelBatch('you'); cancelBatch('them');
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  stopSlideLoop();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (quittingTranscriber) quittingTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
