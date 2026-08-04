"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { PROTOCOL_VERSION } = require("./protocol");
const { runDirectory, sanitize, socketPathFor } = require("./paths");

/**
 * Discovery, by way of one small JSON file per running app.
 *
 * This is Chrome's `DevToolsActivePort` pattern, and it is here because it is
 * the only local-discovery mechanism that also answers the question logs never
 * could: *is the app running right now*. One readdir gives Iris the socket
 * path, liveness and a version to negotiate against, all at once.
 *
 * Not a fixed port — nine apps collide. Not Bonjour — on macOS 15 and later
 * mDNS trips the Local Network prompt, and multicasting to the LAN to find a
 * process on the same machine is absurd.
 */

/**
 * Create a directory only we can enter, and refuse to use one that someone
 * else controls.
 *
 * The mode on the *directory* is the real access control here: reaching a
 * socket requires search permission on every directory above it, and that is
 * enforced everywhere. The mode on the socket file itself is belt and braces,
 * because a few BSD-derived kernels have historically ignored it on connect.
 *
 * Re-checking rather than trusting our own mkdir matters most for the temp
 * fallback, where the parent is world-writable and another user could have
 * created the directory first.
 */
function ensurePrivateDirectory(dir, { platform = process.platform } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (platform === "win32") return dir; // No POSIX modes; ACL inheritance applies.

  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`app-link: ${dir} exists and is not a directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`app-link: ${dir} is owned by uid ${stat.uid}, refusing to use it`);
  }
  if ((stat.mode & 0o077) !== 0) {
    // Tighten rather than fail: an older build may have left it group-readable,
    // and silently refusing to start would be worse than fixing it.
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}

/** Where this app's socket should live, creating its directory as a side effect. */
function prepareSocketPath(appId, options = {}) {
  const target = socketPathFor(appId, options);
  const platform = options.platform || process.platform;
  if (platform === "win32") return target;

  // May be the run directory, or the short temp fallback when the run
  // directory produced a path too long for sun_path. Either way it has to pass
  // the ownership and mode check before anything binds inside it.
  const dir = path.dirname(target);
  ensurePrivateDirectory(dir, { platform });

  // A leftover socket from a killed process makes bind fail with EADDRINUSE.
  // Removing it is safe *because* the directory is ours alone.
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSocket()) fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return target;
}

function instanceFilePath(appId, options = {}) {
  return path.join(runDirectory(options), `${sanitize(appId)}.json`);
}

/**
 * Announce a running app.
 *
 * `token` is a cheap second factor, not a boundary: any process running as
 * this user can read this file. It exists so that a stale or crossed
 * connection fails loudly instead of half-working, and so a future transport
 * with a real identity check has somewhere to put one.
 *
 * `instanceId` closes the PID-reuse hole. A dead PID that the OS has recycled
 * looks alive; the server echoes its instanceId in `describe`, so a client that
 * connected to a stranger finds out on the first call.
 */
function writeInstanceFile(descriptor, options = {}) {
  const { appId, appSlug, appName, appVersion, socketPath } = descriptor;
  const dir = ensurePrivateDirectory(runDirectory(options), options);
  const file = instanceFilePath(appId, options);

  const record = {
    schema: 1,
    appId,
    appSlug: appSlug || null,
    appName: appName || appSlug || appId,
    appVersion: appVersion || null,
    protocolVersion: PROTOCOL_VERSION,
    platform: options.platform || process.platform,
    transport: (options.platform || process.platform) === "win32" ? "npipe" : "unix",
    socketPath,
    pid: options.pid || process.pid,
    instanceId: descriptor.instanceId || crypto.randomUUID(),
    token: descriptor.token || crypto.randomBytes(32).toString("base64url"),
    startedAt: new Date().toISOString(),
  };

  // Write-then-rename so a reader never sees half a file. Same directory, so
  // the rename is atomic.
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

function removeInstanceFile(appId, options = {}) {
  try {
    fs.unlinkSync(instanceFilePath(appId, options));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * Is that PID a process we could be talking to?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH means gone. EPERM means it exists but belongs to another
 * user — which cannot be one of our apps, so it is stale for our purposes.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every app currently announcing itself. Stale entries are dropped, and their
 * files removed on a best effort, so a crash does not leave a permanent ghost
 * in the list.
 */
function listInstances(options = {}) {
  const dir = runDirectory(options);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const alive = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // A half-written or corrupt file is not worth failing discovery over.
    }
    if (!record || typeof record !== "object" || typeof record.socketPath !== "string") continue;

    if (!isProcessAlive(record.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* Someone else may have cleaned it up first. */
      }
      continue;
    }
    record.instanceFile = file;
    alive.push(record);
  }
  return alive;
}

/** One app by id, or null when it is not running. */
function findInstance(appId, options = {}) {
  return listInstances(options).find((record) => record.appId === appId) || null;
}

module.exports = {
  ensurePrivateDirectory,
  prepareSocketPath,
  instanceFilePath,
  writeInstanceFile,
  removeInstanceFile,
  isProcessAlive,
  listInstances,
  findInstance,
  runDirectory,
};
