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

module.exports = { parseSourcesShort, pickMonitorSource, listSources, startThemCapture, stopThemCapture };
