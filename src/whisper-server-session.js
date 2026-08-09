const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { pcmToWav } = require('./wav');

const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 180000;
const HEALTH_POLL_MS = 150;
const INFERENCE_TIMEOUT_MS = 120000;
const PROCESS_EXIT_TIMEOUT_MS = 3000;
const MAX_LOG_TAIL_CHARACTERS = 12000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Whisper port.');
  return address.port;
}

function buildMultipartBody(wav) {
  const boundary = `cue-${crypto.randomBytes(16).toString('hex')}`;
  const fields = [
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  ];
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(fields.join(''), 'utf8'),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
  };
}

class WhisperServerSession {
  /** Supervise one model-loaded whisper-server process for an entire capture session. */
  constructor({
    executablePath,
    runtimeDirectory,
    modelPath,
    language = 'auto',
    threads = 0,
    tinydiarize = false,
    fetchImpl = global.fetch,
    spawnImpl = spawn,
    findPort = findFreeLoopbackPort,
    wait = delay,
    randomBytes = crypto.randomBytes,
    onState = () => {}
  }) {
    if (!executablePath || !runtimeDirectory || !modelPath) {
      throw new Error('WhisperServerSession requires runtime and model paths.');
    }
    if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible implementation is required.');

    this.executablePath = executablePath;
    this.runtimeDirectory = runtimeDirectory;
    this.modelPath = modelPath;
    this.language = language;
    this.threads = Number.isInteger(threads) && threads > 0 ? threads : 0;
    this.tinydiarize = tinydiarize;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.findPort = findPort;
    this.wait = wait;
    this.randomBytes = randomBytes;
    this.onState = onState;
    this.child = null;
    this.endpoint = null;
    this.healthEndpoint = null;
    this.logTail = '';
    this.exitError = null;
    this.stopRequested = false;
    this.inferenceControllers = new Set();
  }

  async start() {
    if (this.child) return;
    this.stopRequested = false;
    this.exitError = null;
    this.logTail = '';
    await Promise.all([
      fs.promises.access(this.executablePath, fs.constants.X_OK),
      fs.promises.access(this.modelPath, fs.constants.R_OK)
    ]);

    const port = await this.findPort();
    const requestPath = `/cue-${this.randomBytes(24).toString('hex')}`;
    this.endpoint = `http://${LOOPBACK_HOST}:${port}${requestPath}/inference`;
    this.healthEndpoint = `http://${LOOPBACK_HOST}:${port}${requestPath}/health`;
    const argumentsList = this._buildArguments(port, requestPath);

    this.onState({ status: 'loading', message: 'Loading the local Whisper model…' });
    this.child = this.spawnImpl(this.executablePath, argumentsList, {
      cwd: this.runtimeDirectory,
      env: this._buildRuntimeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this._observeChild(this.child);

    try {
      await this._waitUntilHealthy();
      this.onState({ status: 'ready', message: 'Local Whisper is ready.' });
    } catch (error) {
      await this.stop({ force: true });
      throw error;
    }
  }

  async transcribe(pcm) {
    if (!this.child || !this.endpoint) throw new Error('Local Whisper is not running.');
    const wav = pcmToWav(Buffer.from(pcm), 16000, 1);
    const multipart = buildMultipartBody(wav);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), INFERENCE_TIMEOUT_MS);
    this.inferenceControllers.add(abortController);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
          'Content-Length': String(multipart.body.length)
        },
        body: multipart.body,
        signal: abortController.signal
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`Local Whisper returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
      }
      const parsed = JSON.parse(responseText);
      return String(parsed.text || '').trim();
    } catch (error) {
      if (abortController.signal.aborted) throw new Error('Local Whisper inference timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
      this.inferenceControllers.delete(abortController);
    }
  }

  abortInferences() {
    for (const controller of this.inferenceControllers) controller.abort();
  }

  async stop({ force = false } = {}) {
    this.stopRequested = true;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.healthEndpoint = null;
    if (!child) return;

    this.abortInferences();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    if (force) return;

    let exitTimeout = null;
    const closedGracefully = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        exitTimeout = setTimeout(() => resolve(false), PROCESS_EXIT_TIMEOUT_MS);
      })
    ]);
    if (exitTimeout) clearTimeout(exitTimeout);
    if (!closedGracefully && child.exitCode === null) child.kill('SIGKILL');
  }

  _buildArguments(port, requestPath) {
    const argumentsList = [
      '--model', this.modelPath,
      '--host', LOOPBACK_HOST,
      '--port', String(port),
      '--request-path', requestPath,
      '--language', this.language,
      '--no-timestamps',
      '--suppress-nst'
    ];
    if (this.threads > 0) argumentsList.push('--threads', String(this.threads));
    if (this.tinydiarize) argumentsList.push('--tinydiarize');
    return argumentsList;
  }

  _buildRuntimeEnvironment() {
    const environment = { ...process.env };
    if (process.platform === 'win32') {
      environment.PATH = `${this.runtimeDirectory}${path.delimiter}${environment.PATH || ''}`;
    } else if (process.platform === 'darwin') {
      environment.DYLD_LIBRARY_PATH = `${this.runtimeDirectory}${path.delimiter}${environment.DYLD_LIBRARY_PATH || ''}`;
    } else {
      environment.LD_LIBRARY_PATH = `${this.runtimeDirectory}${path.delimiter}${environment.LD_LIBRARY_PATH || ''}`;
    }
    return environment;
  }

  _observeChild(child) {
    const collectLog = (data) => {
      this.logTail = (this.logTail + data.toString()).slice(-MAX_LOG_TAIL_CHARACTERS);
    };
    child.stdout?.on('data', collectLog);
    child.stderr?.on('data', collectLog);
    child.once('error', (error) => { this.exitError = error; });
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.exitError = new Error(`whisper-server exited (${code ?? signal}). ${this.logTail.slice(-800)}`);
      }
    });
  }

  async _waitUntilHealthy() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
      if (this.stopRequested) {
        const error = new Error('Local Whisper startup was cancelled.');
        error.code = 'STARTUP_CANCELLED';
        throw error;
      }
      if (this.exitError) throw this.exitError;
      try {
        const response = await this.fetchImpl(this.healthEndpoint);
        if (response.ok) return;
      } catch {
        // Connection refusal is expected until the model has finished loading.
      }
      await this.wait(HEALTH_POLL_MS);
    }
    throw new Error(`Local Whisper did not become ready in time. ${this.logTail.slice(-800)}`);
  }
}

module.exports = {
  WhisperServerSession,
  LOOPBACK_HOST,
  findFreeLoopbackPort,
  buildMultipartBody
};
