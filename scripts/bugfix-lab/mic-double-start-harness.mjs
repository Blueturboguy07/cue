#!/usr/bin/env node
// Executes the REAL, unmodified startMic()/stopMic() functions and the REAL
// cue.on('capture:state', ...) handler straight out of renderer/renderer.js
// (extracted verbatim between stable comment anchors, not retyped), in a
// minimal stub DOM/Electron-preload environment. It then fires one
// capture:state {active:true} event -- exactly what main.js's setCapturing()
// sends exactly once per real toggle-to-active transition (confirmed by
// reading main.js: a single `send('capture:state', ...)` call in that branch)
// -- and counts how many times navigator.mediaDevices.getUserMedia() actually
// runs as a result.
//
// This is a behavioural oracle, not a source grep: it runs cue's real closure
// code path. Exit 1 (bug PRESENT) when getUserMedia fires more than once for
// one activation, because that is the exact defect described in cue PR #69
// ("`capture:state` called startMic() twice ... two AudioWorklet pipelines
// fed the 'you' channel ... the user's own voice didn't [get transcribed]") --
// which is the mechanism that produces this cluster's reported symptom
// ("Microphone input not detected... Voice input is completely ignored").
// Exit 0 when it fires exactly once (bug absent). Exit 2 if the harness could
// not extract or run the code (anchors moved, parse error, etc).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cueDir = process.argv[2];
if (!cueDir) {
  console.error('usage: mic-double-start-harness.mjs <path-to-cue-repo-checkout>');
  process.exit(2);
}

const rendererPath = `${cueDir}/renderer/renderer.js`;
let src;
try {
  src = readFileSync(rendererPath, 'utf8');
} catch (e) {
  console.error(`ORACLE_COULD_NOT_RUN: cannot read ${rendererPath}: ${e.message}`);
  process.exit(2);
}

const lines = src.split('\n');
function findLine(needle, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

// ---- extract the mic capture functions (startMic/stopMic), verbatim ----
const micBlockStart = findLine('let audioCtx = null, micStream = null, micWorklet = null');
const micBlockEnd = findLine('// ---- capture: system/meeting audio', micBlockStart + 1);

// ---- extract the capture:state event handler, verbatim ----
const handlerStart = findLine("cue.on('capture:state'", micBlockEnd + 1);
const handlerEnd = findLine('// ---- real-time transcript display', handlerStart + 1);

if (micBlockStart === -1 || micBlockEnd === -1 || handlerStart === -1 || handlerEnd === -1) {
  console.error('ORACLE_COULD_NOT_RUN: extraction anchors not found ' +
    JSON.stringify({ micBlockStart, micBlockEnd, handlerStart, handlerEnd }));
  console.error('The renderer.js structure around mic capture / capture:state moved enough that ' +
    'this oracle cannot safely extract the real code. Needs a human to update the anchors, not a ' +
    'silent pass/fail.');
  process.exit(2);
}

const micBlockCode = lines.slice(micBlockStart, micBlockEnd).join('\n');
const handlerCode = lines.slice(handlerStart, handlerEnd).join('\n');

// ---- minimal stub environment -------------------------------------------
let getUserMediaCalls = 0;
let micPcmMessages = 0;
const trackLog = [];

class FakeTrack {
  constructor(id) { this.id = id; this.label = 'Fake Windows Mic'; this.muted = false; this._stopped = false; }
  stop() { this._stopped = true; }
}
class FakeMediaStream {
  constructor(id) { this.id = id; this._track = new FakeTrack(id); }
  getAudioTracks() { return [this._track]; }
  getTracks() { return [this._track]; }
}
const navigatorStub = {
  mediaDevices: {
    getUserMedia: async (constraints) => {
      getUserMediaCalls++;
      trackLog.push(`getUserMedia call #${getUserMediaCalls} constraints.audio.sampleRate=${constraints && constraints.audio && constraints.audio.sampleRate}`);
      // Resolve on a real microtask hop, same as a real getUserMedia promise --
      // this does NOT change the outcome: both concurrent startMic() calls
      // still each invoke getUserMedia() synchronously before either's
      // `await` continuation can run.
      return new FakeMediaStream(getUserMediaCalls);
    },
    getDisplayMedia: async () => { throw new Error('not exercised by this harness'); },
  },
};

class FakeAudioWorkletApi {
  async addModule(_path) { /* succeeds, like a packaged Electron build */ }
}
class FakeAudioContext {
  constructor(opts) { this.opts = opts; this.audioWorklet = new FakeAudioWorkletApi(); this.destination = {}; this._closed = false; }
  createMediaStreamSource(_stream) { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  close() { this._closed = true; }
}
class FakeAudioWorkletNode {
  constructor(_ctx, _name) { this.port = { onmessage: null }; this._disconnected = false; }
  connect() {}
  disconnect() { this._disconnected = true; }
}

function genericEl() {
  const cl = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  return {
    classList: cl,
    get textContent() { return this._t || ''; },
    set textContent(v) { this._t = v; },
    closest() { return null; },
  };
}
const documentStub = { getElementById: () => genericEl(), createElement: () => genericEl() };
const $stub = (_sel) => genericEl();
const composerStub = genericEl();

const registered = {};
const cueStub = {
  platform: 'win32',
  log: (_msg) => {},
  micPcm: (_buf) => { micPcmMessages++; },
  on: (channel, cb) => { registered[channel] = cb; },
};

let showStatusCalls = 0;
const showStatusStub = (_msg) => { showStatusCalls++; };
const updateSttStatusStub = (_args) => {};
const setLiveDotStateStub = (_state) => {};
const isWindowsStub = true;

// ---- compile + run the REAL extracted code in this stub environment -----
const fnSource = `
let interimEl = null;
let sttState = 'off';
let captureRequest = 0, captureDesired = false;
const setSessionButton = () => {};
const startSystemAudio = () => {};
const stopSystemAudio = () => {};
${micBlockCode}

${handlerCode}
`;

let buildFn;
try {
  buildFn = new Function(
    'navigator', 'cue', 'AudioContext', 'AudioWorkletNode', 'document',
    'showStatus', 'isWindows', '$', 'composer', 'updateSttStatus', 'setLiveDotState',
    fnSource
  );
} catch (e) {
  console.error('ORACLE_COULD_NOT_RUN: extracted code failed to parse/compile: ' + e.message);
  console.error('--- extracted mic block ---\n' + micBlockCode);
  console.error('--- extracted handler block ---\n' + handlerCode);
  process.exit(2);
}

try {
  buildFn(
    navigatorStub, cueStub, FakeAudioContext, FakeAudioWorkletNode, documentStub,
    showStatusStub, isWindowsStub, $stub, composerStub, updateSttStatusStub, setLiveDotStateStub
  );
} catch (e) {
  console.error('ORACLE_COULD_NOT_RUN: registering the extracted handler threw: ' + e.message);
  process.exit(2);
}

const handler = registered['capture:state'];
if (typeof handler !== 'function') {
  console.error("ORACLE_COULD_NOT_RUN: cue.on('capture:state', ...) never registered a handler");
  process.exit(2);
}

// Fire exactly ONE activation event -- what a real user's single click sends
// (confirmed in main.js: setCapturing(true) calls send('capture:state', ...)
// exactly once in that branch).
handler({ active: true, streaming: false, mode: 'batch' });

// Let every microtask/await in both (if present) startMic() calls settle.
for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));

console.log('--- evidence ---');
console.log(`renderer.js: ${rendererPath}`);
console.log(`extracted mic-block lines: ${micBlockStart + 1}-${micBlockEnd}`);
console.log(`extracted capture:state handler lines: ${handlerStart + 1}-${handlerEnd}`);
console.log(trackLog.join('\n'));
console.log(`getUserMedia call count for ONE capture:state{active:true} event: ${getUserMediaCalls}`);
console.log(`cue.micPcm() messages wired up (post-settle, not counting async worklet emissions): n/a (checked via call count above)`);
console.log(`showStatus() calls: ${showStatusCalls}`);

if (getUserMediaCalls === 1) {
  console.log('RESULT: single mic capture pipeline started -- bug ABSENT');
  process.exit(0);
} else if (getUserMediaCalls > 1) {
  console.log(`RESULT: ${getUserMediaCalls} concurrent mic capture pipelines started from ONE activation -- ` +
    'bug PRESENT (two AudioWorklet/AudioContext pipelines both feed the "you" channel; the interleaved, ' +
    'doubled PCM this produces is exactly what cue PR #69 diagnosed as "meeting audio transcribed, the ' +
    "user's own voice didn't\" -- i.e. \"microphone input not detected\" during a session).");
  process.exit(1);
} else {
  console.error(`ORACLE_COULD_NOT_RUN: getUserMedia was never called (expected startMic() to call it at least once)`);
  process.exit(2);
}
