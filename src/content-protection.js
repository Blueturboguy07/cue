// Cross-compositor "hide from screen capture" for Linux.
//
// This is a COMPOSITOR feature, not a kernel one — exactly like Windows (the DWM
// compositor honours WDA_EXCLUDEFROMCAPTURE) and macOS (WindowServer honours
// NSWindowSharingNone). On Linux the compositor is the Wayland compositor, and
// each one implements exclusion differently or not at all:
//
//   KWin (KDE Plasma 6.6+)  -> ExcludeFromCapture window rule   [src/kwin-capture.js]
//   Hyprland 0.50+          -> noscreenshare window rule        [src/hypr-capture.js]
//   Mutter (GNOME)          -> no client-facing mechanism
//   wlroots (sway, …)       -> no mechanism (screencopy has no exclusion)
//   any X11 session         -> impossible: capture reads the framebuffer directly
//
// There is no standard Wayland protocol for it, so this is necessarily a
// per-compositor dispatch. detect() reports which backend (if any) can do it;
// enable()/disable() route to that backend.
const kwin = require('./kwin-capture');
const hypr = require('./hypr-capture');

const BACKENDS = [
  { name: 'kwin', mod: kwin },
  { name: 'hyprland', mod: hypr }
];

// Returns { supported, compositor, reason, version }.
// reason (when unsupported) explains why, for an honest UI message.
function detect() {
  if (process.platform !== 'linux') return { supported: false, compositor: null, reason: 'not-linux' };
  const results = {};
  for (const b of BACKENDS) {
    const r = b.mod.detectSupport();
    results[b.name] = r;
    if (r.supported) return { supported: true, compositor: b.name, reason: 'ok', version: r.version };
  }
  // Not supported anywhere — surface the most specific reason we have.
  // If we're clearly on a known compositor but it's too old, say so; else the
  // session simply has no mechanism (GNOME/wlroots/X11).
  const specific = Object.values(results).find((r) => r.reason && r.reason.endsWith('-too-old'));
  return {
    supported: false,
    compositor: null,
    reason: specific ? specific.reason : 'no-compositor-support',
    version: specific ? specific.version : undefined
  };
}

function backendFor(compositor) {
  const b = BACKENDS.find((x) => x.name === compositor);
  return b ? b.mod : null;
}

function enable(windowClass, compositor) {
  const mod = backendFor(compositor);
  return mod ? mod.enable(windowClass) : false;
}

function disable(compositor) {
  const mod = backendFor(compositor);
  return mod ? mod.disable() : false;
}

module.exports = { detect, enable, disable };
