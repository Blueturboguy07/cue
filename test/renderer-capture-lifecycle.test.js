const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const captureCode = source.slice(source.indexOf('  let audioCtx = null'), source.indexOf('  // ---- STT / VAD status helpers'));
assert.ok(captureCode.length > 1000, 'renderer capture extraction failed');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stream(audio = true) {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const video = { stopped: false, stop() { this.stopped = true; } };
  return { track, video, getTracks: () => [track, video], getAudioTracks: () => audio ? [track] : [], getVideoTracks: () => [video] };
}

function harness({ platform = 'win32', enabled = true, worklet, noDisplayMedia = false, failFallback = false } = {}) {
  const grants = { mic: [], system: [] }, contexts = [], processors = [], pcm = [], statuses = [];
  const mediaDevices = {};
  for (const [kind, method] of [['mic', 'getUserMedia'], ['system', 'getDisplayMedia']]) {
    mediaDevices[method] = () => { const grant = deferred(); grants[kind].push(grant); return grant.promise; };
  }
  if (noDisplayMedia) delete mediaDevices.getDisplayMedia;
  class Node {
    constructor() { this.port = {}; this.gain = {}; processors.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class Context {
    constructor() { contexts.push(this); this.audioWorklet = { addModule: () => worklet ? worklet.promise : Promise.resolve() }; }
    createMediaStreamSource() { if (this.closed) throw new Error('closed context'); return new Node(); }
    createScriptProcessor() { if (failFallback) throw new Error('no processor'); return new Node(); }
    createGain() { return new Node(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const sandbox = {
    navigator: { mediaDevices }, AudioContext: Context, AudioWorkletNode: Node, MediaStream: class {},
    window: { addEventListener() {} },
    settings: { meetingAudio: enabled }, isMac: platform === 'darwin', isWindows: platform === 'win32',
    cue: { platform, log() {}, micPcm: (data) => pcm.push(data), systemPcm: (data) => pcm.push(data) },
    showStatus: (text) => statuses.push(text), Int16Array,
  };
  vm.runInNewContext(captureCode, sandbox);
  return { ...sandbox, grants, contexts, processors, pcm, statuses };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`Meeting audio Off opens no display capture on ${platform}`, async () => {
    const h = harness({ platform, enabled: false });
    const pending = h.startSystemAudio();
    assert.equal(h.grants.system.length, 0);
    await pending;
  });
}

for (const [kind, start, stop] of [['mic', 'startMic', 'stopMic'], ['system', 'startSystemAudio', 'stopSystemAudio']]) {
  test(`${kind}: Stop disposes a late permission grant`, async () => {
    const h = harness(), input = stream();
    const pending = h[start]();
    h[stop]();
    h.grants[kind][0].resolve(input);
    await pending;
    assert.equal(input.track.stopped, true);
    assert.equal(input.video.stopped, true);
    assert.equal(h.contexts.length, 0);
  });

  test(`${kind}: repeated Start shares one pending permission request`, async () => {
    const h = harness();
    const a = h[start](), b = h[start]();
    assert.equal(h.grants[kind].length, 1);
    h.grants[kind][0].resolve(stream());
    await Promise.all([a, b]);
    h[stop]();
  });

  test(`${kind}: Stop during worklet loading cannot attach or emit PCM`, async () => {
    const worklet = deferred(), h = harness({ worklet }), input = stream();
    const pending = h[start]();
    h.grants[kind][0].resolve(input);
    await Promise.resolve();
    h[stop]();
    worklet.resolve();
    await pending;
    assert.equal(input.track.stopped, true);
    assert.ok(h.contexts.every((ctx) => ctx.closed));
    assert.equal(h.processors.length, 0);
    assert.equal(h.statuses.length, 0, 'a cancelled start must not report an error');
  });

  test(`${kind}: initialization failure releases stream and context`, async () => {
    const worklet = deferred(), h = harness({ worklet, failFallback: true }), input = stream();
    const pending = h[start]();
    h.grants[kind][0].resolve(input);
    worklet.reject(new Error('no worklet'));
    await pending;
    assert.equal(input.track.stopped, true);
    assert.ok(h.contexts.every((ctx) => ctx.closed));
    assert.equal(h.statuses.length, 1);
  });

  test(`${kind}: queued PCM callbacks cannot emit after Stop`, async () => {
    const h = harness(), pending = h[start]();
    h.grants[kind][0].resolve(stream());
    await pending;
    const callback = h.processors.find((p) => p.port.onmessage).port.onmessage;
    callback({ data: 'before' });
    h[stop]();
    callback({ data: 'after' });
    assert.deepEqual(h.pcm, ['before']);
  });

  test(`${kind}: old grants cannot replace or stop a newer session`, async () => {
    const h = harness(), old = stream(), fresh = stream();
    const a = h[start]();
    h[stop]();
    const b = h[start]();
    assert.equal(h.grants[kind].length, 2);
    h.grants[kind][1].resolve(fresh);
    await b;
    h.grants[kind][0].resolve(old);
    await a;
    assert.equal(old.track.stopped, true);
    assert.equal(fresh.track.stopped, false);
    h[stop]();
    assert.equal(fresh.track.stopped, true);
  });
}

test('Meeting audio disabled during a pending grant disposes every track', async () => {
  const h = harness(), input = stream(), pending = h.startSystemAudio();
  h.settings.meetingAudio = false;
  h.grants.system[0].resolve(input);
  await pending;
  assert.equal(input.track.stopped, true);
  assert.equal(input.video.stopped, true);
});

test('unsupported display capture does not wedge the next start', async () => {
  const h = harness({ noDisplayMedia: true });
  await h.startSystemAudio();
  h.navigator.mediaDevices.getDisplayMedia = () => Promise.resolve(stream());
  await h.startSystemAudio();
  assert.equal(h.contexts.length, 1);
  h.stopSystemAudio();
});

for (const [kind, start, stop] of [['mic', 'startMic', 'stopMic'], ['system', 'startSystemAudio', 'stopSystemAudio']]) {
  test(`${kind}: old worklet completion cannot touch the restarted pipeline`, async () => {
    const worklet = deferred(), h = harness({ worklet }), old = stream(), fresh = stream();
    const a = h[start]();
    h.grants[kind][0].resolve(old);
    await Promise.resolve();
    h[stop]();
    const b = h[start]();
    h.grants[kind][1].resolve(fresh);
    await Promise.resolve();
    worklet.resolve();
    await Promise.all([a, b]);
    assert.equal(old.track.stopped, true);
    assert.equal(fresh.track.stopped, false);
    assert.equal(h.contexts.filter((ctx) => !ctx.closed).length, 1);
    assert.equal(h.processors.filter((p) => p.port.onmessage).length, 1);
    h[stop]();
  });

  test(`${kind}: throwing cleanup cannot leave other tracks or the context live`, async () => {
    const h = harness(), input = stream(), pending = h[start]();
    h.grants[kind][0].resolve(input);
    await pending;
    input.track.stop = () => { throw new Error('disconnected device'); };
    input.video.stopped = false;
    for (const node of h.processors) node.disconnect = () => { throw new Error('already disconnected'); };
    assert.doesNotThrow(() => h[stop]());
    assert.equal(input.video.stopped, true);
    assert.ok(h.contexts.every((ctx) => ctx.closed));
  });

  test(`${kind}: seeded interleavings always release every acquired resource`, async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const h = harness(), pending = [], inputs = [];
      let random = seed, resolved = 0;
      for (let step = 0; step < 80; step++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const operation = random % 3;
        if (operation === 0) pending.push(h[start]());
        else if (operation === 1) h[stop]();
        else if (resolved < h.grants[kind].length) {
          const input = stream(); inputs.push(input);
          h.grants[kind][resolved++].resolve(input);
          await new Promise(setImmediate);
        }
      }
      h[stop]();
      while (resolved < h.grants[kind].length) {
        const input = stream(); inputs.push(input);
        h.grants[kind][resolved++].resolve(input);
      }
      await Promise.all(pending);
      assert.ok(inputs.every((input) => input.track.stopped && input.video.stopped), `seed ${seed}`);
      assert.ok(h.contexts.every((ctx) => ctx.closed), `seed ${seed}`);
    }
  });
}

test('non-boolean Meeting audio settings fail closed', async () => {
  for (const enabled of [undefined, null, 0, 1, 'false', 'true', {}, []]) {
    const h = harness({ enabled });
    // The fixture defaults missing values, so assign the malformed stored value explicitly.
    h.settings.meetingAudio = enabled;
    await h.startSystemAudio();
    assert.equal(h.grants.system.length, 0);
  }
});

test('missing loopback audio releases the display and permits a later retry', async () => {
  const h = harness(), input = stream(false), first = h.startSystemAudio();
  h.grants.system[0].resolve(input);
  await first;
  assert.equal(input.video.stopped, true);
  const second = h.startSystemAudio();
  assert.equal(h.grants.system.length, 2);
  h.grants.system[1].resolve(stream());
  await second;
  h.stopSystemAudio();
});

function buttonHarness() {
  let click;
  const requests = [], buttons = [], events = new Map();
  const counts = { micStarts: 0, micStops: 0, systemStops: 0 };
  const sandbox = {
    $: () => ({ classList: { toggle() {} }, addEventListener: (_event, fn) => { click = fn; } }),
    cue: {
      captureSet: (active) => { const result = deferred(); requests.push({ active, result }); return result.promise; },
      on: (channel, fn) => events.set(channel, fn),
    },
    setSessionButton: (active) => buttons.push(active),
    startSystemAudio: () => new Promise(() => {}), startMic: () => { counts.micStarts++; },
    stopMic: () => { counts.micStops++; }, stopSystemAudio: () => { counts.systemStops++; },
    setLiveDotState() {}, showStatus() {}, setSttState() {}, updateSttStatus() {},
    composer: { classList: { toggle() {} } }, settings: { meetingAudio: true },
  };
  const buttonCode = source.slice(source.indexOf('  let captureDesired = false;'), source.indexOf('  // Transcript toggle removed'));
  const handlerCode = source.slice(source.indexOf("  cue.on('capture:state'"), source.indexOf('  // ---- real-time transcript display'));
  const context = vm.createContext(sandbox);
  vm.runInContext('let interimEl = null;\n' + buttonCode + handlerCode, context);
  return { click, requests, buttons, events, counts, context };
}

test('Start/Stop clicks reach main immediately while display permission is pending', async () => {
  const h = buttonHarness();
  const first = h.click(), second = h.click();
  assert.deepEqual(h.requests.map((r) => r.active), [true, false]);
  assert.equal(h.counts.micStops, 1);
  assert.equal(h.counts.systemStops, 1);
  h.requests[1].result.resolve(false);
  h.requests[0].result.resolve(true);
  await Promise.all([first, second]);
  assert.equal(h.buttons.at(-1), false);
});

test('an obsolete Stop reply cannot stop a newer integration activation', async () => {
  const h = buttonHarness();
  h.events.get('capture:state')({ active: true });
  const stopping = h.click();
  h.events.get('capture:state')({ active: true });
  h.requests[0].result.resolve(false);
  await stopping;
  assert.equal(h.buttons.at(-1), true);
  assert.equal(h.counts.micStops, 1);
  assert.equal(h.counts.systemStops, 1);
});

test('a stale startup snapshot cannot revive input after a Stop event', async () => {
  const h = buttonHarness(), snapshot = deferred();
  h.context.cue.captureState = () => snapshot.promise;
  const code = source.slice(source.indexOf('    const stateRequest = captureRequest;'), source.indexOf('    if (!settings.onboarded) showOnboard();'));
  const pending = vm.runInContext('(async () => {\n' + code + '\n})()', h.context);
  h.events.get('capture:state')({ active: false });
  snapshot.resolve({ active: true, desired: true });
  await pending;
  assert.equal(h.counts.micStarts, 0);
  assert.equal(h.buttons.at(-1), false);
});
