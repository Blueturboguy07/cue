const assert = require('node:assert/strict');
const test = require('node:test');
const { loadMain, deferred } = require('./helpers/main-harness');

test('Stop during a screenshot prevents the feature from sending it to a provider', async () => {
  const screen = deferred(); let requests = 0;
  const h = loadMain({ modules: {
    './src/screen': { captureScreenshot: () => screen.promise },
    './src/llm': { createLLM: () => ({ ready: true, stream: async () => { requests++; return 'answer'; } }) },
  } });
  await h.setCapturing(true);
  const pending = h.runFeature('ask', 'synthetic prompt');
  await h.setCapturing(false);
  screen.resolve('data:image/png;base64,synthetic');
  await pending;
  assert.equal(requests, 0);
  assert.equal(h.state.busy, false);
});

test('Stop aborts an LLM stream and late callbacks cannot affect the next answer', async () => {
  const answer = deferred(), entered = deferred(); let params;
  const h = loadMain({ modules: {
    './src/llm': { createLLM: () => ({ ready: true, stream: (p) => { params = p; entered.resolve(); return answer.promise; } }) },
  } });
  await h.setCapturing(true);
  const pending = h.runFeature('say', '');
  await entered.promise;
  await h.setCapturing(false);
  const signal = params.signal;
  params.onToken('private late token');
  answer.resolve('answer');
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(h.events.some((e) => e.channel === 'llm:token'), false);
  assert.equal(h.state.busy, false);
});

test('Stop aborts batch STT and its late transcript cannot enter a new session', async () => {
  const result = deferred(), entered = deferred(); let signal;
  const h = loadMain({ modules: {
    './src/stt': { createSTT: () => ({ available: true, transcribe: (_pcm, options) => { signal = options?.signal; entered.resolve(); return result.promise; } }) },
  } });
  await h.setCapturing(true);
  h.buffers.you.push(Buffer.alloc(6400, 30));
  const pending = h.flushChannel('you');
  await entered.promise;
  await h.setCapturing(false);
  await h.setCapturing(true);
  result.resolve({ text: 'private words from the old session' });
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(h.transcript.length, 0);
  assert.equal(h.state.transcribing.you, false);
  await h.setCapturing(false);
});

test('Meeting audio Off drops PCM at the main-process boundary', async () => {
  const h = loadMain();
  await h.setCapturing(true);
  h.handlers.get('settings:set')(null, { meetingAudio: false });
  h.listeners.get('system:pcm')(null, Buffer.alloc(6400, 30));
  assert.equal(h.buffers.them.length, 0);
  assert.ok(h.events.some((e) => e.channel === 'meeting-audio:state' && !e.data.enabled));
  await h.setCapturing(false);
});

function syntheticSources() {
  return [{ thumbnail: { isEmpty: () => false, getSize: () => ({ width: 8, height: 8 }), toBitmap: () => Buffer.alloc(8 * 8 * 4) } }];
}

test('Stop during hash capture prevents full screenshot and caption requests', async () => {
  const frame = deferred(); let screenshots = 0, captions = 0;
  const h = loadMain({ electron: { desktopCapturer: { getSources: () => frame.promise } }, modules: {
    './src/screen': { captureScreenshot: async () => { screenshots++; return 'synthetic'; } },
    './src/llm': { createLLM: () => ({ ready: true, stream: async () => { captions++; return 'caption'; } }) },
  } });
  await h.setCapturing(true);
  const pending = h.pollSlides();
  await h.setCapturing(false);
  await pending;
  frame.resolve(syntheticSources());
  await new Promise(setImmediate);
  assert.equal(screenshots, 0);
  assert.equal(captions, 0);
});

test('Stop aborts slide caption transport and discards its late result', async () => {
  const caption = deferred(), entered = deferred(); let signal;
  const h = loadMain({ electron: { desktopCapturer: { getSources: async () => syntheticSources() } }, modules: {
    './src/screen': { captureScreenshot: async () => 'synthetic' },
    './src/llm': { createLLM: () => ({ ready: true, stream: (p) => { signal = p.signal; entered.resolve(); return caption.promise; } }) },
  } });
  await h.setCapturing(true);
  const pending = h.pollSlides();
  await entered.promise;
  await h.setCapturing(false);
  await pending;
  assert.equal(signal.aborted, true);
  caption.resolve('private late caption');
  await new Promise(setImmediate);
  assert.equal(h.events.some((e) => e.channel === 'slides:update' && e.data.count > 0), false);
});

test('turning slide tracking Off cancels a pending screenshot before it can leave the device', async () => {
  const screenshot = deferred(), entered = deferred(); let captions = 0;
  const h = loadMain({ electron: { desktopCapturer: { getSources: async () => syntheticSources() } }, modules: {
    './src/screen': { captureScreenshot: () => { entered.resolve(); return screenshot.promise; } },
    './src/llm': { createLLM: () => ({ ready: true, stream: async () => { captions++; return 'caption'; } }) },
  } });
  await h.setCapturing(true);
  const pending = h.pollSlides();
  await entered.promise;
  h.handlers.get('settings:set')(null, { slides: { enabled: false } });
  await pending;
  screenshot.resolve('synthetic');
  await new Promise(setImmediate);
  assert.equal(captions, 0);
  await h.setCapturing(false);
});

test('a timed-out LLM request aborts its transport and releases the busy state', async () => {
  const entered = deferred(), callbacks = new Map(); let signal, timerId = 0;
  const h = loadMain({ timers: {
    setTimeout: (fn) => { callbacks.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => callbacks.delete(id),
  }, modules: {
    './src/llm': { createLLM: () => ({ ready: true, stream: (p) => { signal = p.signal; entered.resolve(); return new Promise(() => {}); } }) },
  } });
  const pending = h.runFeature('say', '');
  await entered.promise;
  callbacks.values().next().value();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(callbacks.size, 0);
  assert.equal(h.state.busy, false);
  assert.ok(h.events.some((e) => e.channel === 'llm:error' && /timed out/.test(e.data.message)));
});

test('a transient caption failure can retry the same slide', async () => {
  let attempts = 0;
  const h = loadMain({ electron: { desktopCapturer: { getSources: async () => syntheticSources() } }, modules: {
    './src/screen': { captureScreenshot: async () => 'synthetic' },
    './src/llm': { createLLM: () => ({ ready: true, stream: async () => { if (++attempts === 1) throw new Error('temporary connection failure'); return 'caption'; } }) },
  } });
  await h.setCapturing(true);
  await h.pollSlides();
  await h.pollSlides();
  assert.equal(attempts, 2);
  assert.ok(h.events.some((e) => e.channel === 'slides:update' && e.data.count === 1));
  await h.setCapturing(false);
});

test('Stop during local model validation prevents the sidecar from being created', async () => {
  const vm = require('node:vm'), validation = deferred(), entered = deferred(); let constructed = 0;
  const h = loadMain({ settings: { sttProvider: 'local' }, modules: {
    './src/whisper-runtime': { locateWhisperRuntime: () => ({ available: true, executablePath: '/synthetic/runtime' }) },
    './src/local-whisper-transcriber': { LocalWhisperTranscriber: class { constructor() { constructed++; } } },
  } });
  h.context.syntheticManager = { verifyInstalledModel: () => { entered.resolve(); return validation.promise; } };
  vm.runInContext('whisperModelManager = syntheticManager;', h.context);
  const pending = h.setCapturing(true);
  await entered.promise;
  await h.setCapturing(false);
  validation.resolve('/synthetic/model.bin');
  assert.equal(await pending, false);
  assert.equal(constructed, 0);
  assert.equal(h.events.some((e) => e.channel === 'capture:state' && e.data.active), false);
});

test('a rejected streaming startup cannot leave capture active', async () => {
  const h = loadMain({ modules: {
    './src/stt-streaming': { createStreamingSTT: () => { throw new Error('synthetic startup failure'); } },
  } });
  await assert.rejects(h.setCapturing(true), /synthetic startup failure/);
  assert.equal(h.captureController.desired, false);
  assert.equal(h.state.capturing, false);
  assert.ok(h.events.some((e) => e.channel === 'capture:state' && !e.data.active));
});

for (const event of ['did-start-loading', 'render-process-gone', 'closed']) {
  test(`${event} stops the main session and invalidates capture grants`, async () => {
    const vm = require('node:vm'), callbacks = new Map();
    class Window {
      constructor() { this.webContents = { on: (name, fn) => callbacks.set(name, fn), send() {} }; }
      on(name, fn) { callbacks.set(name, fn); }
      isDestroyed() { return false; }
      setContentProtection() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      setHiddenInMissionControl() {}
      loadFile() {}
      setTitle() {}
    }
    const h = loadMain({ electron: {
      BrowserWindow: Window,
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    } });
    vm.runInContext('createWindow();', h.context);
    await h.setCapturing(true);
    const signal = h.captureController.signal;
    callbacks.get(event)({}, { reason: 'synthetic-crash' });
    assert.equal(signal.aborted, true);
    assert.equal(h.state.capturing, false);
    assert.equal(h.captureController.desired, false);
  });
}
