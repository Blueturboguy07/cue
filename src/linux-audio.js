// Linux "Them" channel: record the PulseAudio/PipeWire monitor source in the
// MAIN process with `parec`. Chromium deliberately filters monitor devices out
// of enumerateDevices and has no loopback capture on Linux, so the renderer
// cannot reach system audio at all — the sidecar recorder is the only path.
// parec ships in libpulse (same package as pactl) and pipewire-pulse serves it
// on PipeWire systems, so it is present wherever desktop audio works.
const { spawn, execFile } = require('child_process');

// "51\talsa_output.pci...analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED"
function parseSourcesShort(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split('\t');
      return { id: cols[0], name: cols[1] || '', monitor: (cols[1] || '').endsWith('.monitor') };
    })
    .filter((s) => s.name);
}

// Preference order: the stored source if it still exists, the default sink's
// monitor, any monitor.
function pickMonitorSource(sources, preferredName, defaultSink) {
  const list = sources || [];
  if (preferredName) {
    const preferred = list.find((s) => s.name === preferredName);
    if (preferred) return preferred;
  }
  if (defaultSink) {
    const ofDefault = list.find((s) => s.name === defaultSink + '.monitor');
    if (ofDefault) return ofDefault;
  }
  return list.find((s) => s.monitor) || null;
}

function pactl(args) {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function listSources() {
  const [short, sink] = await Promise.all([pactl(['list', 'sources', 'short']), pactl(['get-default-sink'])]);
  return {
    sources: short === null ? null : parseSourcesShort(short),
    defaultSink: sink ? sink.trim() : ''
  };
}

// Spawns parec producing exactly the PCM routeAudio expects: s16le, 16 kHz, mono.
let proc = null;
let generation = 0; // incremented on every stop, to cancel in-flight starts
async function startThemCapture(preferredName, onData, onStatus) {
  stopThemCapture();
  // listSources() is async; a Stop landing during it must win, or we'd spawn a
  // parec that keeps recording system audio after the user turned listening off.
  // stopThemCapture() bumps `generation`; if it changes across the await, bail.
  const myGeneration = generation;
  const { sources, defaultSink } = await listSources();
  if (generation !== myGeneration) return false; // superseded by a Stop
  if (sources === null) {
    onStatus('Meeting audio needs PulseAudio or PipeWire (pactl was not found). Your mic still works.');
    return false;
  }
  const source = pickMonitorSource(sources, preferredName, defaultSink);
  if (!source) {
    onStatus('No "Monitor of …" audio source found — is PipeWire/PulseAudio running? Your mic still works.');
    return false;
  }
  if (generation !== myGeneration) return false; // final check before spawning
  const child = spawn('parec', [
    '--device=' + source.name,
    '--format=s16le', '--rate=16000', '--channels=1',
    '--latency-msec=60'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc = child;
  child.stdout.on('data', (chunk) => { if (proc === child) onData(chunk); });
  child.on('error', () => {
    if (proc === child) proc = null;
    onStatus('Could not start parec (install libpulse / pulseaudio-utils). Your mic still works.');
  });
  child.on('exit', (code, signal) => {
    if (proc === child) proc = null;
    // SIGTERM is our own stop; anything else mid-capture is worth surfacing.
    if (signal !== 'SIGTERM' && code !== 0 && code !== null) {
      onStatus('System-audio capture stopped unexpectedly (parec exited ' + code + ').');
    }
  });
  console.log('[cue] linux them capture: parec on ' + source.name);
  return true;
}

function stopThemCapture() {
  generation++; // supersede any in-flight startThemCapture() still in its await
  if (proc) {
    const p = proc;
    proc = null;
    try { p.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
}

// ---- microphone: don't break the user's Bluetooth music ----------------------
// Opening a Bluetooth headset's mic forces PipeWire to flip it from A2DP (music
// quality, no mic) to HFP/HSP (mono phone-call codec) — which collapses whatever
// the user is listening to. So when the default mic is a Bluetooth headset, cue
// records from a different, wired/built-in mic instead and leaves the headset
// alone. Pure helper: given `pactl list sources short` output + the default,
// return the pactl name of a non-Bluetooth mic, or null if there is none.
function pickNonBluetoothMic(sources, defaultSource) {
  const list = (sources || []).filter((s) => !s.monitor);
  const isBt = (name) => /^bluez_/i.test(name || '');
  if (!isBt(defaultSource)) return null; // default is fine, nothing to do
  const wired = list.find((s) => !isBt(s.name));
  return wired ? wired.name : null;
}

// Main-side: what mic should the renderer open? Returns { deviceLabelHint,
// sourceName, reason } — the renderer matches deviceLabelHint against
// enumerateDevices labels (Chromium exposes PulseAudio source descriptions).
async function micAdvice() {
  const [short, def, descs] = await Promise.all([
    pactl(['list', 'sources', 'short']),
    pactl(['get-default-source']),
    pactl(['list', 'sources'])
  ]);
  if (short === null) return { sourceName: null, reason: 'no-pactl' };
  const sources = parseSourcesShort(short);
  const defaultSource = def ? def.trim() : '';
  const alt = pickNonBluetoothMic(sources, defaultSource);
  if (!alt) return { sourceName: null, reason: 'default-ok' };
  // Find the human description PipeWire gives this source — that's the label
  // Chromium's enumerateDevices shows, which the renderer can match on.
  let description = '';
  const block = String(descs || '').split(/\n(?=Source #)/).find((b) => b.includes('Name: ' + alt));
  const m = block && block.match(/Description:\s*(.+)/);
  if (m) description = m[1].trim();
  return { sourceName: alt, description, reason: 'avoid-bluetooth-hfp' };
}

module.exports = { parseSourcesShort, pickMonitorSource, pickNonBluetoothMic, micAdvice, listSources, startThemCapture, stopThemCapture };
