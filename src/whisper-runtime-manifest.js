const path = require('path');

const WHISPER_CPP_VERSION = '1.9.1';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}`;
const SOURCE_ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.zip`;
// NOTE: this pins a GitHub auto-generated source archive, which is not
// byte-stable — GitHub may recompress it, invalidating the hash without any
// upstream release change. If the macOS source build starts failing with
// "Artifact checksum verification failed", that is why. The Windows/Linux
// targets use release assets instead and do not have this problem.
const SOURCE_ARCHIVE_SHA256 = '98a57a88ef0e733b746544f8ea25157d3265fbf0dac5c32dbb527e6ef4dbfaac';

const RUNTIME_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'zip',
    filename: 'whisper-bin-x64.zip',
    bytes: 7982101,
    sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
    executable: 'whisper-server.exe'
  }),
  'linux-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-x64.tar.gz',
    bytes: 9379235,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    executable: 'whisper-server'
  }),
  'linux-arm64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-arm64.tar.gz',
    bytes: 4555819,
    sha256: 'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3',
    executable: 'whisper-server'
  }),
  'darwin-x64': Object.freeze({
    kind: 'source',
    sourceArchitecture: 'x86_64',
    executable: 'whisper-server'
  }),
  'darwin-arm64': Object.freeze({
    kind: 'source',
    sourceArchitecture: 'arm64',
    executable: 'whisper-server'
  })
});

function getRuntimeTarget(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`;
  const target = RUNTIME_TARGETS[key];
  if (!target) throw new Error(`Local Whisper is not packaged for ${key}.`);
  return {
    ...target,
    key,
    url: target.kind === 'archive' ? `${RELEASE_BASE_URL}/${target.filename}` : SOURCE_ARCHIVE_URL
  };
}

function getRuntimeExecutablePath(runtimeDirectory, platform = process.platform, architecture = process.arch) {
  return path.join(runtimeDirectory, getRuntimeTarget(platform, architecture).executable);
}

module.exports = {
  WHISPER_CPP_VERSION,
  RUNTIME_TARGETS,
  SOURCE_ARCHIVE_URL,
  SOURCE_ARCHIVE_SHA256,
  getRuntimeTarget,
  getRuntimeExecutablePath
};
