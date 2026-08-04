"use strict";

const os = require("node:os");
const path = require("node:path");

/**
 * Where the run directory lives, per platform. These mirror the locations
 * docs/publik-sdk-convention.md already uses for logs and consent, so an app
 * that follows the convention has one publik directory, not two.
 */
function publikDirectory({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "publik");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "publik");
  }
  const stateHome = env.XDG_STATE_HOME || path.join(homedir, ".local", "state");
  return path.join(stateHome, "publik");
}

/** One JSON file per running app. See runfile.js. */
function runDirectory(options = {}) {
  return path.join(publikDirectory(options), "run");
}

/** Per-app record of which callers the user has already answered for. */
function consentDirectory(options = {}) {
  return path.join(publikDirectory(options), "consent");
}

/**
 * A Unix socket path is copied into `sun_path`, which is 104 bytes on macOS
 * and 108 on Linux — including the terminator. Exceed it and `bind` fails with
 * ENAMETOOLONG, or worse, silently truncates on some systems.
 *
 * "~/Library/Application Support/publik/run/<bundle-id>.sock" fits for most
 * people and blows the limit for a long username plus a long bundle id. So:
 * try the run directory, and fall back to a private directory under the
 * system temp root, which is short. Discovery never notices, because the
 * instance file carries the real path either way — which is the whole reason
 * the instance file exists.
 */
const SUN_PATH_MAX = 104;

function socketPathFor(appId, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    // Named pipes are not filesystem paths and have no length problem worth
    // worrying about. The name is per-user so two accounts on one machine do
    // not collide.
    return `\\\\.\\pipe\\publik-${sanitize(appId)}-${userKey(options)}`;
  }

  const preferred = path.join(runDirectory(options), `${sanitize(appId)}.sock`);
  if (Buffer.byteLength(preferred, "utf8") < SUN_PATH_MAX) return preferred;

  return path.join(shortSocketDirectory(options), `${sanitize(appId)}.sock`);
}

/**
 * The fallback socket directory: `<tmp>/publik-<uid>`, created 0700.
 *
 * The system temp root is world-writable, so this directory is only safe if we
 * check that it is ours and private *every time* rather than trusting that we
 * created it — the classic temp-directory race. ensureShortSocketDirectory()
 * in runfile.js does that check and refuses to use a directory that fails it.
 */
function shortSocketDirectory(options = {}) {
  const tmp = (options.env && options.env.TMPDIR) || os.tmpdir();
  return path.join(tmp, `publik-${userKey(options)}`);
}

function userKey(options = {}) {
  if (options.uid !== undefined) return String(options.uid);
  if (typeof process.getuid === "function") return String(process.getuid());
  return sanitize(os.userInfo().username);
}

/**
 * Bundle ids and package names are already conservative, but this is a path
 * component built from configuration, so it gets sanitized rather than
 * trusted. A `..` here would be a directory traversal in the run directory.
 */
function sanitize(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`app-link: unusable app id ${JSON.stringify(value)}`);
  }
  return cleaned;
}

module.exports = {
  SUN_PATH_MAX,
  publikDirectory,
  runDirectory,
  consentDirectory,
  socketPathFor,
  shortSocketDirectory,
  sanitize,
};
