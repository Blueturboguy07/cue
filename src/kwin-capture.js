// Content protection on Linux — the real thing, not a no-op.
//
// Electron's setContentProtection() does nothing on Linux, and X11 genuinely
// cannot exclude a window from capture (any client reads the framebuffer).
// But KWin (KDE's compositor) gained a per-window "ExcludeFromCapture" property
// in Plasma 6.6, and on a Wayland session ALL screen capture — screenshots and
// the PipeWire screencast that Meet/Zoom/OBS use — flows through KWin, so an
// excluded window is genuinely absent from every capture path.
//
// There is no client-facing Wayland protocol for it, but KWin honours a
// persistent *window rule*. We write that rule (matched to cue's window class)
// with kwriteconfig6 and reload KWin over D-Bus. Verified live on Plasma 6.7.3:
// toggling the rule makes cue's overlay appear/vanish in a screenshot while it
// stays on screen.
//
// Sources:
//   https://invent.kde.org/plasma/kwin/-/merge_requests/8442  (ExcludeFromCapture)
//   https://invent.kde.org/plasma/kwin/-/merge_requests/8828  (window rule)
const { execFileSync } = require('child_process');

const RULE_ID = 'cue-hide-from-screencast';
const RULE_DESC = 'cue: hide from screen recording';
const MIN_MAJOR = 6;
const MIN_MINOR = 6;

// Pure: the kwinrulesrc key/value pairs for excluding `windowClass`.
// wmclassmatch=1 (exact), excludefromcapturerule=2 (Force). Case-sensitive —
// windowClass must be the exact WM_CLASS/app_id KWin sees.
function buildRule(windowClass) {
  return {
    Description: RULE_DESC,
    wmclass: windowClass,
    wmclassmatch: '1',
    wmclasscomplete: 'false',
    excludefromcapture: 'true',
    excludefromcapturerule: '2'
  };
}

// Pure: merge RULE_ID into a kwinrulesrc "rules=" list without duplicating or
// disturbing the user's other rules. `present`=false removes it.
function mergeRulesList(current, present) {
  const ids = String(current || '').split(',').map((s) => s.trim()).filter(Boolean);
  const without = ids.filter((id) => id !== RULE_ID);
  return present ? without.concat(RULE_ID).join(',') : without.join(',');
}

// Pure: parse a "6.7.3"-style version out of a --version blob.
function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0), raw: m[0] } : null;
}

// Pure: does this version meet the Plasma 6.6 floor?
function versionMeetsFloor(v) {
  return !!v && (v.major > MIN_MAJOR || (v.major === MIN_MAJOR && v.minor >= MIN_MINOR));
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
}
function commandExists(cmd) {
  try { run('sh', ['-c', `command -v ${cmd}`]); return true; } catch (_) { return false; }
}
function kwinVersion() {
  for (const cmd of ['kwin_wayland', 'plasmashell']) {
    try {
      const v = parseVersion(run(cmd, ['--version']));
      if (v) return v;
    } catch (_) { /* try next */ }
  }
  return null;
}

// Is genuine capture exclusion available on this session?
function detectSupport() {
  if (process.platform !== 'linux') return { supported: false, reason: 'not-linux' };
  const desktop = `${process.env.XDG_CURRENT_DESKTOP || ''} ${process.env.XDG_SESSION_DESKTOP || ''}`;
  if (!/kde|plasma/i.test(desktop)) return { supported: false, reason: 'not-kde' };
  if (process.env.XDG_SESSION_TYPE !== 'wayland' && !process.env.WAYLAND_DISPLAY) {
    return { supported: false, reason: 'not-wayland' };
  }
  if (!commandExists('kwriteconfig6') || !commandExists('qdbus6')) {
    return { supported: false, reason: 'missing-tools' };
  }
  const v = kwinVersion();
  if (!v) return { supported: false, reason: 'unknown-version' };
  if (!versionMeetsFloor(v)) return { supported: false, reason: 'kwin-too-old', version: v.raw };
  return { supported: true, reason: 'ok', version: v.raw };
}

function setKey(group, key, value) {
  run('kwriteconfig6', ['--file', 'kwinrulesrc', '--group', group, '--key', key, value]);
}
function readKey(group, key) {
  try { return run('kreadconfig6', ['--file', 'kwinrulesrc', '--group', group, '--key', key]).trim(); }
  catch (_) { return ''; }
}
function reconfigure() {
  try { run('qdbus6', ['org.kde.KWin', '/KWin', 'reconfigure']); } catch (_) { /* best effort */ }
}

// Write (or refresh) the exclusion rule and apply it live. Idempotent.
function enable(windowClass) {
  try {
    const rule = buildRule(windowClass);
    for (const [k, v] of Object.entries(rule)) setKey(RULE_ID, k, v);
    setKey('General', 'rules', mergeRulesList(readKey('General', 'rules'), true));
    reconfigure();
    return true;
  } catch (_) { return false; }
}

// Turn the rule off by delisting it (KWin ignores groups not in the rules list)
// and apply live. Idempotent, and never creates the group — so opting out on a
// machine that never enabled protection leaves kwinrulesrc untouched.
function disable() {
  try {
    setKey('General', 'rules', mergeRulesList(readKey('General', 'rules'), false));
    reconfigure();
    return true;
  } catch (_) { return false; }
}

module.exports = {
  RULE_ID, buildRule, mergeRulesList, parseVersion, versionMeetsFloor,
  detectSupport, enable, disable
};
