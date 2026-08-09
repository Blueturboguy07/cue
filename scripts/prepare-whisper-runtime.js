#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const extractZip = require('extract-zip');
const tar = require('tar');
const {
  WHISPER_CPP_VERSION,
  SOURCE_ARCHIVE_SHA256,
  getRuntimeTarget,
  getRuntimeExecutablePath
} = require('../src/whisper-runtime-manifest');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE_ROOT = path.join(PROJECT_ROOT, '.cache', 'whisper-runtime');
const LICENSE_PATH = path.join(PROJECT_ROOT, 'build-resources', 'whisper.cpp.LICENSE');
const RUNTIME_MANIFEST_FILENAME = 'runtime.json';

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertSafeManagedDirectory(targetPath, parentPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(parentPath);
  const relativePath = path.relative(resolvedParent, resolvedTarget);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to replace unmanaged directory: ${resolvedTarget}`);
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArtifact(url, destinationPath, expectedBytes, expectedSha256) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);

  const output = fs.createWriteStream(destinationPath, { flags: 'wx' });
  try {
    for await (const chunk of response.body) {
      if (!output.write(Buffer.from(chunk))) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
    }
  } finally {
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  }

  const fileStats = await fs.promises.stat(destinationPath);
  if (expectedBytes && fileStats.size !== expectedBytes) {
    throw new Error(`Artifact size mismatch: expected ${expectedBytes}, received ${fileStats.size}.`);
  }
  const actualSha256 = await sha256(destinationPath);
  if (actualSha256 !== expectedSha256) throw new Error('Artifact checksum verification failed.');
}

async function findFile(rootDirectory, filename) {
  const pendingDirectories = [rootDirectory];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(entryPath);
      if (entry.isFile() && entry.name === filename) return entryPath;
    }
  }
  throw new Error(`Could not find ${filename} in the prepared whisper.cpp files.`);
}

function shouldCopyRuntimeEntry(filename, executableName) {
  return filename === executableName ||
    filename === 'LICENSE' ||
    filename.endsWith('.dll') ||
    filename.endsWith('.dylib') ||
    filename.includes('.so');
}

async function copyRuntimeDependencies(sourceDirectory, executableName, destinationDirectory) {
  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!shouldCopyRuntimeEntry(entry.name, executableName)) continue;
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    await fs.promises.cp(sourcePath, destinationPath, { recursive: false, dereference: false });
  }
  await fs.promises.copyFile(LICENSE_PATH, path.join(destinationDirectory, 'whisper.cpp.LICENSE'));
  if (process.platform !== 'win32') {
    await fs.promises.chmod(path.join(destinationDirectory, executableName), 0o755);
  }
}

async function prepareArchiveTarget(target, temporaryDirectory, destinationDirectory) {
  const archivePath = path.join(temporaryDirectory, target.filename);
  const extractionDirectory = path.join(temporaryDirectory, 'extracted');
  await fs.promises.mkdir(extractionDirectory, { recursive: true });
  await downloadArtifact(target.url, archivePath, target.bytes, target.sha256);

  if (target.archiveType === 'zip') {
    await extractZip(archivePath, { dir: extractionDirectory });
  } else {
    await extractTarWithMaterializedLinks(archivePath, extractionDirectory);
  }

  const executablePath = await findFile(extractionDirectory, target.executable);
  await copyRuntimeDependencies(path.dirname(executablePath), target.executable, destinationDirectory);
}

function resolveArchivePath(extractionDirectory, archivePath) {
  if (!archivePath || path.posix.isAbsolute(archivePath)) {
    throw new Error(`Unsafe archive path: ${archivePath}`);
  }
  const normalizedArchivePath = path.posix.normalize(archivePath);
  if (normalizedArchivePath === '..' || normalizedArchivePath.startsWith('../')) {
    throw new Error(`Unsafe archive path: ${archivePath}`);
  }
  const resolvedPath = path.resolve(extractionDirectory, ...normalizedArchivePath.split('/'));
  const resolvedRoot = path.resolve(extractionDirectory);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Archive path escaped extraction root: ${archivePath}`);
  }
  return resolvedPath;
}

// Time O(e + l²), space O(l): l is only the archive's small symlink alias set.
async function extractTarWithMaterializedLinks(archivePath, extractionDirectory) {
  const symbolicLinks = [];
  await tar.t({
    file: archivePath,
    onentry(entry) {
      if (entry.type === 'SymbolicLink') {
        symbolicLinks.push({ archivePath: entry.path, linkPath: entry.linkpath });
      }
    }
  });

  await tar.x({
    file: archivePath,
    cwd: extractionDirectory,
    strict: true,
    filter: (_entryPath, entry) => entry.type !== 'SymbolicLink'
  });

  const linkByArchivePath = new Map(symbolicLinks.map((link) => [link.archivePath, link]));
  for (const link of symbolicLinks) {
    let targetArchivePath = path.posix.normalize(path.posix.join(path.posix.dirname(link.archivePath), link.linkPath));
    const visitedPaths = new Set([link.archivePath]);
    while (linkByArchivePath.has(targetArchivePath)) {
      if (visitedPaths.has(targetArchivePath)) throw new Error(`Cyclic archive link: ${link.archivePath}`);
      visitedPaths.add(targetArchivePath);
      const targetLink = linkByArchivePath.get(targetArchivePath);
      targetArchivePath = path.posix.normalize(path.posix.join(path.posix.dirname(targetLink.archivePath), targetLink.linkPath));
    }

    const sourcePath = resolveArchivePath(extractionDirectory, targetArchivePath);
    const destinationPath = resolveArchivePath(extractionDirectory, link.archivePath);
    await fs.promises.copyFile(sourcePath, destinationPath);
  }
}

function runCMake(argumentsList, workingDirectory) {
  execFileSync('cmake', argumentsList, {
    cwd: workingDirectory,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
}

async function prepareMacTarget(target, temporaryDirectory, destinationDirectory) {
  if (process.platform !== 'darwin') {
    throw new Error(`The ${target.key} runtime must be compiled on macOS.`);
  }

  const sourceArchivePath = path.join(temporaryDirectory, `whisper.cpp-${WHISPER_CPP_VERSION}.zip`);
  const sourceExtractionDirectory = path.join(temporaryDirectory, 'source');
  const buildDirectory = path.join(temporaryDirectory, 'build');
  await fs.promises.mkdir(sourceExtractionDirectory, { recursive: true });
  await downloadArtifact(target.url, sourceArchivePath, null, SOURCE_ARCHIVE_SHA256);
  await extractZip(sourceArchivePath, { dir: sourceExtractionDirectory });
  const sourceDirectory = path.dirname(await findFile(sourceExtractionDirectory, 'CMakeLists.txt'));

  runCMake([
    '-S', sourceDirectory,
    '-B', buildDirectory,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${target.sourceArchitecture}`,
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_NATIVE=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_SERVER=ON',
    '-DWHISPER_BUILD_TOOLS=OFF'
  ], temporaryDirectory);
  runCMake([
    '--build', buildDirectory,
    '--config', 'Release',
    '--target', 'whisper-server',
    '--parallel', String(Math.max(1, Math.min(os.cpus().length, 6)))
  ], temporaryDirectory);

  const executablePath = await findFile(buildDirectory, target.executable);
  await copyRuntimeDependencies(path.dirname(executablePath), target.executable, destinationDirectory);
}

async function hasCurrentRuntime(runtimeDirectory, target) {
  const executablePath = getRuntimeExecutablePath(runtimeDirectory, target.key.split('-')[0], target.key.split('-').slice(1).join('-'));
  try {
    const metadata = JSON.parse(await fs.promises.readFile(path.join(runtimeDirectory, RUNTIME_MANIFEST_FILENAME), 'utf8'));
    await fs.promises.access(executablePath, fs.constants.X_OK);
    return metadata.version === WHISPER_CPP_VERSION && metadata.target === target.key;
  } catch {
    return false;
  }
}

async function replaceManagedDirectory(sourceDirectory, destinationDirectory, parentDirectory) {
  assertSafeManagedDirectory(destinationDirectory, parentDirectory);
  await fs.promises.mkdir(parentDirectory, { recursive: true });
  await fs.promises.rm(destinationDirectory, { recursive: true, force: true });
  await fs.promises.cp(sourceDirectory, destinationDirectory, { recursive: true, dereference: false });
}

/** Prepare a checksum-pinned runtime, using a per-platform cache across builds. */
async function prepareWhisperRuntime({
  platform = process.platform,
  architecture = process.arch,
  cacheRoot = DEFAULT_CACHE_ROOT,
  outputDirectory = null
} = {}) {
  const target = getRuntimeTarget(platform, architecture);
  const cachedRuntimeDirectory = path.join(cacheRoot, target.key);

  if (!(await hasCurrentRuntime(cachedRuntimeDirectory, target))) {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cue-whisper-runtime-'));
    const preparedDirectory = path.join(temporaryDirectory, 'prepared');
    try {
      if (target.kind === 'archive') {
        await prepareArchiveTarget(target, temporaryDirectory, preparedDirectory);
      } else {
        await prepareMacTarget(target, temporaryDirectory, preparedDirectory);
      }
      await fs.promises.writeFile(path.join(preparedDirectory, RUNTIME_MANIFEST_FILENAME), JSON.stringify({
        name: 'whisper.cpp',
        version: WHISPER_CPP_VERSION,
        target: target.key
      }, null, 2));
      await replaceManagedDirectory(preparedDirectory, cachedRuntimeDirectory, cacheRoot);
    } finally {
      const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
      if (resolvedTemporaryDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        await fs.promises.rm(resolvedTemporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  if (outputDirectory) {
    const outputParent = path.dirname(path.resolve(outputDirectory));
    await replaceManagedDirectory(cachedRuntimeDirectory, outputDirectory, outputParent);
  }
  return outputDirectory || cachedRuntimeDirectory;
}

async function main() {
  const outputDirectory = readArgument('output');
  const runtimeDirectory = await prepareWhisperRuntime({
    platform: readArgument('platform') || process.platform,
    architecture: readArgument('arch') || process.arch,
    outputDirectory: outputDirectory ? path.resolve(outputDirectory) : null
  });
  process.stdout.write(`Prepared whisper.cpp ${WHISPER_CPP_VERSION} runtime at ${runtimeDirectory}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  prepareWhisperRuntime,
  assertSafeManagedDirectory,
  shouldCopyRuntimeEntry,
  extractTarWithMaterializedLinks
};
