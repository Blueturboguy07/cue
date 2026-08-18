// Content protection on Hyprland (Wayland).
//
// Hyprland 0.50 added a `noscreenshare` window rule: the compositor paints a
// black rectangle where the window is in any screencopy stream, so the window's
// content never reaches a screen recording. We add the rule live for cue's
// window class with `hyprctl keyword` (session-only — it clears on the next
// Hyprland reload, and cue re-applies it each launch), no config-file edit.
//
// Verified mechanism per the Hyprland wiki; not runtime-tested in this repo's
// dev environment (KDE). Sources:
//   https://wiki.hypr.land/Configuring/Window-Rules/  (noscreenshare)
const { execFileSync } = require('child_process');

const MIN_MAJOR = 0;
const MIN_MINOR = 50; // noscreenshare landed in 0.50.0

// Pure: the Hyprland window rule value that blacks this class out of captures.
function buildRule(windowClass) {
  return `noscreenshare, class:^(${windowClass})$`;
}

// Pure: parse "v0.50.1"-style versions from `hyprctl version`.
function parseVersion(text) {
  const m = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] } : null;
}

// Pure: does this version have noscreenshare (>= 0.50)?
function versionMeetsFloor(v) {
  return !!v && (v.major > MIN_MAJOR || (v.major === MIN_MAJOR && v.minor >= MIN_MINOR));
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
}
function commandExists(cmd) {
  try { run('sh', ['-c', `command -v ${cmd}`]); return true; } catch (_) { return false; }
}
function hyprVersion() {
  try { return parseVersion(run('hyprctl', ['version'])); } catch (_) { return null; }
}

function detectSupport() {
  if (process.platform !== 'linux') return { supported: false, reason: 'not-linux' };
  const isHypr = !!process.env.HYPRLAND_INSTANCE_SIGNATURE
    || /hyprland/i.test(`${process.env.XDG_CURRENT_DESKTOP || ''} ${process.env.XDG_SESSION_DESKTOP || ''}`);
  if (!isHypr) return { supported: false, reason: 'not-hyprland' };
  if (!commandExists('hyprctl')) return { supported: false, reason: 'missing-hyprctl' };
  const v = hyprVersion();
  if (!v) return { supported: false, reason: 'unknown-version' };
  if (!versionMeetsFloor(v)) return { supported: false, reason: 'hyprland-too-old', version: v.raw };
  return { supported: true, reason: 'ok', version: v.raw };
}

// Add the rule live. noscreenshare is consulted per captured frame, so it
// applies to the already-open window on the next frame. Idempotent (Hyprland
// dedupes identical keyword rules).
function enable(windowClass) {
  try { run('hyprctl', ['keyword', 'windowrulev2', buildRule(windowClass)]); return true; }
  catch (_) { return false; }
}

// There is no clean per-rule live removal; reload re-reads the user's config,
// dropping our session-only keyword. Only hit on explicit opt-out.
function disable() {
  try { run('hyprctl', ['reload']); return true; }
  catch (_) { return false; }
}

module.exports = { buildRule, parseVersion, versionMeetsFloor, detectSupport, enable, disable };
