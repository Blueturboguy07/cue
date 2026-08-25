// Linux meeting-audio loopback. Chromium filters PulseAudio monitor sources out of
// enumerateDevices(), so getDisplayMedia has no reliable system-audio path here.
// Instead we expose the default sink's monitor as a regular source via
// module-remap-source; the renderer then captures it with plain getUserMedia.
const { execFile, execFileSync } = require('child_process');

const SOURCE_NAME = 'cue_system_mic';
const LABEL = 'CueSystemAudio';

function pactl(args) {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// The master= arg pins the sink at load time, so a module from an earlier run
// (default output switched since, or PipeWire restarted) captures silence.
// Always unload first, then reload against the current default sink.
async function ensureLoopbackSource() {
  const modules = await pactl(['list', 'short', 'modules']);
  if (modules === null) return { ok: false, error: 'pactl not available' };
  for (const line of modules.split('\n')) {
    if (line.includes(`source_name=${SOURCE_NAME}`)) {
      await pactl(['unload-module', line.trim().split(/\s+/)[0]]);
    }
  }
  const sink = (await pactl(['get-default-sink']) || '').trim();
  if (!sink) return { ok: false, error: 'no default sink' };
  const loaded = await pactl([
    'load-module', 'module-remap-source',
    `source_name=${SOURCE_NAME}`,
    `master=${sink}.monitor`,
    `source_properties=device.description=${LABEL}`,
  ]);
  if (loaded === null) return { ok: false, error: `module-remap-source failed for ${sink}` };
  return { ok: true, sink };
}

// Quit-path cleanup; sync so it completes before the process exits.
function unloadLoopbackSource() {
  try {
    const modules = execFileSync('pactl', ['list', 'short', 'modules'], { timeout: 5000, encoding: 'utf8' });
    for (const line of modules.split('\n')) {
      if (line.includes(`source_name=${SOURCE_NAME}`)) {
        execFileSync('pactl', ['unload-module', line.trim().split(/\s+/)[0]], { timeout: 5000 });
      }
    }
  } catch { /* best effort: a stale source is harmless and reloaded on next run */ }
}

module.exports = { ensureLoopbackSource, unloadLoopbackSource, SOURCE_NAME, LABEL };

