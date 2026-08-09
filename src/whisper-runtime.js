const fs = require('fs');
const path = require('path');
const { getRuntimeExecutablePath, getRuntimeTarget, WHISPER_CPP_VERSION } = require('./whisper-runtime-manifest');

/** Locate only prepackaged or explicitly prepared runtimes; never fetch code. */
function locateWhisperRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env
}) {
  const target = getRuntimeTarget(platform, architecture);
  const candidates = [];

  if (environment.CUE_WHISPER_RUNTIME) {
    candidates.push(path.resolve(environment.CUE_WHISPER_RUNTIME));
  }
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'whisper-runtime'));
  }
  if (!isPackaged && appPath) {
    candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
  }

  for (const runtimeDirectory of candidates) {
    const executablePath = getRuntimeExecutablePath(runtimeDirectory, platform, architecture);
    if (fs.existsSync(executablePath)) {
      return {
        available: true,
        version: WHISPER_CPP_VERSION,
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
