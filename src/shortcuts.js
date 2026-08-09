// Configurable global shortcuts. Kept dependency-free so it is unit-testable.
// Accelerator strings follow Electron's format, e.g. 'CommandOrControl+Return'.

const DEFAULTS = {
  assist: 'CommandOrControl+Return',
  leetcode: 'CommandOrControl+H',
  quit: 'CommandOrControl+Shift+X',
  hide: 'Shift+Q', // Windows-only convenience (no Cmd key)
  listening: 'CommandOrControl+Shift+L',
  passthrough: 'CommandOrControl+Shift+I',
  screen: 'CommandOrControl+Shift+S'
};

// Every action that maps to a shortcut. Values = defaults; can be overridden via settings.
function resolveShortcuts(overrides = {}) {
  const out = {};
  for (const [action, def] of Object.entries(DEFAULTS)) {
    const v = (overrides && overrides[action]) || def;
    out[action] = v;
  }
  return out;
}

// Detect collisions between configured accelerators (a global shortcut can only be
// registered once). Returns an array of [actionA, actionB, accelerator] pairs.
function findConflicts(map) {
  const seen = new Map();
  const conflicts = [];
  for (const [action, accel] of Object.entries(map)) {
    if (!accel) continue;
    const key = accel.trim().toLowerCase();
    if (seen.has(key)) conflicts.push([seen.get(key), action, accel]);
    else seen.set(key, action);
  }
  return conflicts;
}

// Basic validity check: must contain at least a non-modifier key and plausible modifiers.
function isValid(accel) {
  if (!accel || typeof accel !== 'string') return false;
  const parts = accel.split('+').map((s) => s.trim());
  if (parts.some((p) => !p)) return false;
  const modifiers = new Set(['CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']);
  const keys = parts.filter((p) => !modifiers.has(p));
  return keys.length >= 1;
}

module.exports = { DEFAULTS, resolveShortcuts, findConflicts, isValid };
