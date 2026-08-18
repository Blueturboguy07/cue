// Full-resolution screenshot via native screencapture on macOS (or desktopCapturer on Windows/Linux).
const { desktopCapturer, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function captureMacNative() {
  return new Promise((resolve) => {
    const tmpPath = path.join(os.tmpdir(), `cue_capture_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', tmpPath], (err) => {
      if (err) {
        return resolve(null);
      }
      try {
        if (!fs.existsSync(tmpPath)) return resolve(null);
        const buf = fs.readFileSync(tmpPath);
        fs.unlink(tmpPath, () => {});
        if (!buf || buf.length === 0) return resolve(null);
        resolve('data:image/png;base64,' + buf.toString('base64'));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function captureScreenshot() {
  if (process.platform === 'darwin') {
    const macDataUrl = await captureMacNative();
    if (macDataUrl) return macDataUrl;
  }

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetWidth, height: targetHeight }
    });
    if (!sources || !sources.length) return null;

    let chosen = sources.find((s) => String(s.display_id) === String(primary.id) && s.thumbnail && !s.thumbnail.isEmpty());
    if (!chosen) {
      chosen = sources.find((s) => s.thumbnail && !s.thumbnail.isEmpty()) || sources[0];
    }
    const img = chosen && chosen.thumbnail;
    if (!img || img.isEmpty()) return null;
    return img.toDataURL();
  } catch (_) {
    return null;
  }
}

module.exports = { captureScreenshot };
