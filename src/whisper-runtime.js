const fs = require('fs');
const path = require('path');
const { getRuntimeExecutablePath, getRuntimeTarget, WHISPER_CPP_VERSION } = require('./whisper-runtime-manifest');

/** Locate only prepackaged or explicitly prepared runtimes; never fetch code. */
function locateWhisperRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  userDataPath,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env
}) {
  const target = getRuntimeTarget(platform, architecture);
  const candidates = [];

  if (environment.CUE_WHISPER_RUNTIME) {
    candidates.push(path.resolve(environment.CUE_WHISPER_RUNTIME));
  }
  // A user-built GPU runtime (scripts/build-whisper-vulkan.sh) is preferred over
  // the bundled CPU one: large models (v3-turbo) are ~50x slower on CPU than on
  // any GPU, which made them look broken. Lives in userData so it survives app
  // updates. userDataPath is passed by main; env fallback covers tests/scripts.
  const userData = environment.CUE_USER_DATA || (typeof userDataPath === 'string' ? userDataPath : null);
  if (userData) candidates.push(path.join(userData, 'whisper-runtime-gpu'));
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'whisper-runtime'));
  }
  if (!isPackaged && appPath) {
    candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
  }

  for (const runtimeDirectory of candidates) {
    const executablePath = getRuntimeExecutablePath(runtimeDirectory, platform, architecture);
    if (fs.existsSync(executablePath)) {
      let backend = 'cpu', version = WHISPER_CPP_VERSION;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'runtime.json'), 'utf8'));
        if (meta.backend) backend = String(meta.backend);
        if (meta.version) version = String(meta.version);
      } catch (_) { /* bundled runtime has no backend field -> cpu */ }
      return {
        available: true,
        version,
        backend,
        target: target.key,
        runtimeDirectory,
        executablePath
      };
    }
  }

  return {
    available: false,
    version: WHISPER_CPP_VERSION,
    target: target.key,
    runtimeDirectory: candidates[0] || null,
    executablePath: null,
    message: isPackaged
      ? `The packaged Whisper runtime for ${target.key} is missing.`
      : 'Run npm run prepare:whisper before using local transcription from source.'
  };
}

module.exports = { locateWhisperRuntime };
