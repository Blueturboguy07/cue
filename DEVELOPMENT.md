# Cue — Developer & Contributor Guide

## 1. Prerequisites
* **macOS:** Apple Silicon (macOS 14+ Sonoma or macOS 15+ Sequoia recommended)
* **Node.js:** `>= 22.12.0` (active version: `v24.14.0`)
* **Package Manager:** npm `11.11.0+`
* **Xcode Command Line Tools:** `xcode-select --install`

---

## 2. Common Workflows

### 2.1 Running the Development Server
To launch Cue from source in development mode:
```bash
cd /Users/milan/Projects/cue
npm start
```

### 2.2 Running Automated Unit Tests
Cue uses Node's native test runner (`node --test`):
```bash
npm test
```
*Note: All 130 tests must pass before submitting or deploying changes.*

### 2.3 Compiling Local Whisper Runtime
To build the native `whisper.cpp` C++ binary with Metal GPU acceleration:
```bash
npm run prepare:whisper
```
The compiled server will be output to `.cache/whisper-runtime/darwin-arm64/whisper-server`.

### 2.4 Syncing Changes to `/Applications/cue.app`
When code in `/Users/milan/Projects/cue` is updated and tested, sync and re-sign the standalone app:
```bash
# 1. Sync updated files
cp -R main.js /Applications/cue.app/Contents/Resources/app/
cp -R src/ /Applications/cue.app/Contents/Resources/app/src/
cp -R renderer/ /Applications/cue.app/Contents/Resources/app/renderer/

# 2. Re-sign with Apple Developer certificate
codesign --force --deep --options runtime \
  --entitlements build-resources/entitlements.mac.plist \
  --sign "Apple Development: milantiwari2003@gmail.com (9KYMR669PW)" \
  /Applications/cue.app

# 3. Restart the app
pkill -f "/Applications/cue.app" || true
open -a /Applications/cue.app
```

### 2.5 Packaging a Fresh Release (.zip or .dmg)
To build a complete distribution package:
```bash
npm run dist:mac
```
Output artifacts are saved in `dist/`.
