const assert = require('node:assert/strict');
const test = require('node:test');
const { createCaptureController } = require('../src/capture-controller');

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('Stop resolves and aborts even while startup is stalled', async () => {
  const ready = deferred(); let signal, stops = 0;
  const capture = createCaptureController({ start: async (s) => { signal = s; await ready.promise; return true; }, stop: () => { stops++; } });
  const starting = capture.set(true);
  await new Promise(setImmediate);
  assert.equal(await capture.set(false), false);
  assert.equal(signal.aborted, true);
  assert.equal(stops, 1);
  ready.resolve();
  assert.equal(await starting, false);
  assert.equal(capture.desired, false);
});

test('rapid start/stop/start serializes starts and only the newest can succeed', async () => {
  const ready = deferred(), signals = [];
  const capture = createCaptureController({ start: async (s) => { signals.push(s); if (signals.length === 1) await ready.promise; return true; }, stop() {} });
  const first = capture.set(true);
  await new Promise(setImmediate);
  const stopped = capture.set(false), latest = capture.set(true);
  assert.equal(await stopped, false);
  assert.equal(signals.length, 1);
  ready.resolve();
  assert.equal(await first, false);
  assert.equal(await latest, true);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('an obsolete failed start cannot clear a newer desired state', async () => {
  const ready = deferred(); let starts = 0;
  const capture = createCaptureController({ start: async () => { if (++starts === 1) { await ready.promise; throw new Error('cancelled old startup'); } return true; }, stop() {} });
  const first = capture.set(true);
  await new Promise(setImmediate);
  await capture.set(false);
  const latest = capture.set(true);
  const failure = assert.rejects(first, /cancelled old/);
  ready.resolve();
  await failure;
  assert.equal(await latest, true);
  assert.equal(capture.desired, true);
});

test('repeated explicit starts are idempotent and failed startup is retryable', async () => {
  let starts = 0;
  const capture = createCaptureController({ start: async () => ++starts > 1, stop() {} });
  const first = capture.set(true);
  assert.equal(capture.set(true), first);
  assert.equal(await first, false);
  assert.equal(capture.desired, false);
  assert.equal(await capture.toggle(), true);
  assert.equal(starts, 2);
  assert.equal(await capture.toggle(), false);
  assert.throws(() => capture.set('false'), TypeError);
});

test('hundreds of queued toggles converge without opening obsolete sessions', async () => {
  let starts = 0, stops = 0;
  const capture = createCaptureController({ start: async (signal) => { assert.equal(signal.aborted, false); starts++; return true; }, stop: () => { stops++; } });
  const requests = Array.from({ length: 1000 }, () => capture.toggle());
  await Promise.all(requests);
  assert.equal(capture.desired, false);
  assert.equal(starts, 0);
  assert.equal(stops, 500);
  assert.equal(await capture.set(true), true);
  assert.equal(starts, 1);
});
