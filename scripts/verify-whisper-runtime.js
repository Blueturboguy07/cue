#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const { locateWhisperRuntime } = require('../src/whisper-runtime');

function buildRuntimeEnvironment(runtimeDirectory) {
  const environment = { ...process.env };
  if (process.platform === 'win32') {
    environment.PATH = `${runtimeDirectory}${path.delimiter}${environment.PATH || ''}`;
  } else if (process.platform === 'darwin') {
    environment.DYLD_LIBRARY_PATH = `${runtimeDirectory}${path.delimiter}${environment.DYLD_LIBRARY_PATH || ''}`;
  } else {
    environment.LD_LIBRARY_PATH = `${runtimeDirectory}${path.delimiter}${environment.LD_LIBRARY_PATH || ''}`;
  }
  return environment;
}

const runtime = locateWhisperRuntime({
  isPackaged: false,
  resourcesPath: process.resourcesPath,
  appPath: path.resolve(__dirname, '..'),
  platform: process.platform,
  architecture: process.arch,
  environment: process.env
});
if (!runtime.available) throw new Error(runtime.message);

const result = spawnSync(runtime.executablePath, ['--help'], {
  cwd: runtime.runtimeDirectory,
  env: buildRuntimeEnvironment(runtime.runtimeDirectory),
  encoding: 'utf8',
  windowsHide: true
});
if (result.error) throw result.error;
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status !== 0 || !output.includes('whisper-server') || !output.includes('--model')) {
  throw new Error(`whisper-server smoke test failed (${result.status}).\n${output.slice(-1200)}`);
}
process.stdout.write(`Verified whisper.cpp ${runtime.version} runtime for ${runtime.target}.\n`);
