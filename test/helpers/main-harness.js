const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const file = path.join(__dirname, '../../main.js');
const source = fs.readFileSync(file, 'utf8');
const requireMain = createRequire(file);

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function loadMain(overrides = {}) {
  const events = [], handlers = new Map(), listeners = new Map();
  const settings = { provider: 'openai', sttProvider: 'auto', meetingAudio: true, apiKeys: {}, slides: { enabled: true }, ...overrides.settings };
  const app = { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {}, getPath: () => '/synthetic-cue-data', getAppPath: () => '/synthetic-cue-app' };
  const store = {
    getSettings: () => settings,
    setSettings: (patch) => Object.assign(settings, patch),
    stripRendererPatch: (patch) => patch, redactForRenderer: (s) => s,
  };
  const timers = { setTimeout, clearTimeout, ...overrides.timers };
  const realGiveUp = requireMain('./src/give-up');
  const mocks = {
    electron: { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) }, ...overrides.electron },
    './src/store': store,
    './src/applink': { recordEvent() {} },
    './src/llm': { createLLM: () => ({ ready: true, stream: async () => 'synthetic answer' }) },
    './src/stt-streaming': { createStreamingSTT: () => ({ type: 'batch' }) },
    './src/give-up': { giveUpTimer: (ms, msg, t) => realGiveUp.giveUpTimer(ms, msg, t || timers) },
    ...overrides.modules,
  };
  const context = vm.createContext({
    require: (name) => name in mocks ? mocks[name] : requireMain(name),
    __dirname: path.dirname(file), process, Buffer, AbortController, AbortSignal,
    console: { log() {}, error() {} }, setTimeout, clearTimeout, ...overrides.timers,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    testSend: (channel, data) => events.push({ channel, data }),
  });
  vm.runInContext(source + `\nwin = { isDestroyed: () => false, webContents: { send: testSend } };\n` +
    `globalThis.api = { state, transcript, buffers, captureController, setCapturing, runFeature, flushChannel, pollSlides, startSlideLoop, stopSlideLoop };`, context, { filename: file });
  return { ...context.api, events, handlers, listeners, settings, context };
}

module.exports = { loadMain, deferred };
