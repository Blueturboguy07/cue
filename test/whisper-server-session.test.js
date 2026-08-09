const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { WhisperServerSession, buildMultipartBody } = require('../src/whisper-server-session');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('loads one server process and reuses it for multiple in-memory inferences', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-whisper-session-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
  const modelPath = path.join(root, 'ggml-fixture.bin');
  fs.writeFileSync(executablePath, 'runtime');
  fs.writeFileSync(modelPath, 'model');
  fs.chmodSync(executablePath, 0o755);

  const child = new FakeChild();
  const spawnCalls = [];
  const fetchCalls = [];
  const session = new WhisperServerSession({
    executablePath,
    runtimeDirectory: root,
    modelPath,
    language: 'en',
    threads: 3,
    spawnImpl: (...args) => { spawnCalls.push(args); return child; },
    findPort: async () => 43123,
    randomBytes: (size) => Buffer.alloc(size, 7),
    wait: async () => {},
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (!options.method) return { ok: true, status: 200 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'hello locally' }) };
    }
  });

  await session.start();
  await session.start();
  assert.equal(spawnCalls.length, 1);
  const argumentsList = spawnCalls[0][1];
  assert.deepEqual(argumentsList.slice(0, 2), ['--model', modelPath]);
  assert.ok(argumentsList.includes('--request-path'));
  assert.ok(!argumentsList.includes('--convert'));

  assert.equal(await session.transcribe(Buffer.alloc(3200)), 'hello locally');
  assert.equal(await session.transcribe(Buffer.alloc(3200)), 'hello locally');
  assert.equal(spawnCalls.length, 1);
  assert.equal(fetchCalls.filter((call) => call.options.method === 'POST').length, 2);
  assert.ok(fetchCalls.every((call) => call.url.startsWith('http://127.0.0.1:43123/cue-')));

  await session.stop();
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('builds a WAV multipart request entirely in memory', () => {
  const multipart = buildMultipartBody(Buffer.from('RIFFfixture'));
  assert.match(multipart.boundary, /^cue-[a-f0-9]+$/);
  assert.ok(multipart.body.includes(Buffer.from('filename="audio.wav"')));
  assert.ok(multipart.body.includes(Buffer.from('RIFFfixture')));
});

test('cancels model loading and force-terminates the sidecar', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-whisper-cancel-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
  const modelPath = path.join(root, 'ggml-fixture.bin');
  fs.writeFileSync(executablePath, 'runtime');
  fs.writeFileSync(modelPath, 'model');
  fs.chmodSync(executablePath, 0o755);

  const child = new FakeChild();
  let releaseHealthPoll;
  let markHealthPollStarted;
  const healthPollStarted = new Promise((resolve) => { markHealthPollStarted = resolve; });
  const session = new WhisperServerSession({
    executablePath,
    runtimeDirectory: root,
    modelPath,
    spawnImpl: () => child,
    findPort: async () => 43124,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    wait: async () => {
      markHealthPollStarted();
      await new Promise((resolve) => { releaseHealthPoll = resolve; });
    }
  });

  const startup = session.start();
  const rejectedStartup = assert.rejects(startup, (error) => error.code === 'STARTUP_CANCELLED');
  await healthPollStarted;
  await session.stop({ force: true });
  releaseHealthPoll();
  await rejectedStartup;
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});
