// Screenshot via native screencapture on macOS, falling back to desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Vision models downscale anything larger than ~1568 px on the long edge
// anyway, and a gateway sitting on Vercel refuses request bodies over 4.5 MB
// before any route code runs (413, with no body the app can shape). A Retina
// PNG of a busy screen is commonly 5–15 MB, so every screenshot is resized to
// this long edge and encoded as JPEG before it is base64'd into the prompt.
const MAX_LONG_EDGE_PX = 1568;
const JPEG_QUALITY = 70;
// What the encoded data URL must stay under so the whole request, prompt and
// all, fits in the gateway's 4 MB request rule with room to spare.
const MAX_DATA_URL_BYTES = 3 * 1024 * 1024;

/**
 * Downscale a NativeImage to the long-edge cap (never upscale) and encode it as
 * a JPEG data URL. Pure with respect to Electron: the image is duck-typed
 * (getSize / resize / toJPEG), so it is unit-testable without a display.
 */
function encodeScreenshot(img, { maxLongEdge = MAX_LONG_EDGE_PX, quality = JPEG_QUALITY } = {}) {
  const { width, height } = img.getSize();
  let out = img;
  if (width > maxLongEdge || height > maxLongEdge) {
    out = width >= height ? img.resize({ width: maxLongEdge }) : img.resize({ height: maxLongEdge });
  }
  const jpeg = out.toJPEG(quality);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/**
 * Capture full-resolution screen on macOS using /usr/sbin/screencapture.
 * Bypasses ScreenCaptureKit/desktopCapturer empty thumbnail issues on macOS
 * and returns a NativeImage, or null if capture failed.
 */
function captureMacNative() {
  return new Promise((resolve) => {
    const tmpPath = path.join(os.tmpdir(), `cue_capture_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', tmpPath], (err) => {
      if (err) return resolve(null);
      try {
        if (!fs.existsSync(tmpPath)) return resolve(null);
        const img = nativeImage && nativeImage.createFromPath ? nativeImage.createFromPath(tmpPath) : null;
        fs.unlink(tmpPath, () => {});
        if (!img || img.isEmpty()) return resolve(null);
        resolve(img);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function captureScreenshot() {
  if (process.platform === 'darwin') {
    const macImg = await captureMacNative();
    if (macImg) return encodeScreenshot(macImg);
  }

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
  return encodeScreenshot(img); // data:image/jpeg;base64,...
}

module.exports = { captureScreenshot, encodeScreenshot, captureMacNative, MAX_LONG_EDGE_PX, JPEG_QUALITY, MAX_DATA_URL_BYTES };
