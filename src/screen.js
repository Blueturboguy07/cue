// Full-resolution screenshot (main process).
// mac/win + Linux-X11: Electron's desktopCapturer, as always.
// Linux-Wayland: desktopCapturer goes through the xdg-desktop-portal screencast
// path, which fails without an interactive picker (and can crash the GPU
// process), so shell out to the desktop's own screenshot tool instead —
// spectacle (KDE), grim (wlroots), gnome-screenshot — which capture silently.
// The PNG touches a private temp file for a moment; it is unlinked immediately.
const { desktopCapturer, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isLinux = process.platform === 'linux';
const isWayland = isLinux && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

const CLI_TOOLS = [
  { cmd: 'spectacle', args: (f) => ['-b', '-n', '-o', f] },
  { cmd: 'grim', args: (f) => [f] },
  { cmd: 'gnome-screenshot', args: (f) => ['-f', f] },
  { cmd: 'import', args: (f) => ['-window', 'root', f] } // ImageMagick, X11 fallback
];
let cliTool; // cached after first successful capture

function runTool(tool, file) {
  return new Promise((resolve) => {
    execFile(tool.cmd, tool.args(file), { timeout: 10000 }, (err) => resolve(!err));
  });
}

async function captureViaCli() {
  // Private 0700 dir instead of a guessable /tmp name (avoids a symlink/read race
  // on the shared tmp dir); removed with the screenshot on every path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-shot-'));
  const file = path.join(dir, 'screen.png');
  try {
    // Try the previously-working tool first, but fall back to the others if it
    // fails this time (a transient failure shouldn't disable screenshots).
    const tools = cliTool ? [cliTool, ...CLI_TOOLS.filter((t) => t.cmd !== cliTool.cmd)] : CLI_TOOLS;
    for (const tool of tools) {
      if (await runTool(tool, file) && fs.existsSync(file) && fs.statSync(file).size > 0) {
        cliTool = tool;
        return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
      }
    }
    return null;
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* never written */ }
    try { fs.rmdirSync(dir); } catch (_) { /* best effort */ }
  }
}

async function captureViaDesktopCapturer() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  return img.toDataURL(); // data:image/png;base64,...
}

async function captureScreenshot() {
  if (isWayland) {
    const viaCli = await captureViaCli();
    if (viaCli) return viaCli;
    // No CLI tool available — last-ditch portal attempt rather than nothing.
    return captureViaDesktopCapturer().catch(() => null);
  }
  return captureViaDesktopCapturer();
}

module.exports = { captureScreenshot };
