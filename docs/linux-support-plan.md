# Linux Support Implementation Plan

> **Planning Document**
> Target: Linux support (X11 & Wayland) for `cue`
> Scope Boundary: Standard, documented OS and compositor APIs only. No stealth/evasion mechanisms. Honest capability disclosures for unsupported desktop features.

---

## 1. Platform-Branch Inventory

Comprehensive audit of all platform-conditional logic across `main.js`, `preload.js`, `src/`, `scripts/`, `renderer/`, and `vendor/`.

| File & Location | Current Behavior | Linux Requirement / Behavior |
|---|---|---|
| `main.js:21-23` | Appends Chromium switch `enable-features=MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride` on `darwin`. | **Linux action:** Leave macOS check untouched. For Wayland/PipeWire screen and audio sharing, evaluate whether `--enable-features=WebRTCPipeWireCapturer` is needed on older Electron runtimes (default enabled in Electron 33). |
| `main.js:35-36` | Defines `const isMac = process.platform === 'darwin'; const isWindows = process.platform === 'win32';`. | **Linux action:** Define `const isLinux = process.platform === 'linux';` to allow explicit Linux branch handling where needed. |
| `main.js:41-47` | Computes Windows build number and `WIN_SUPPORTS_CONTENT_PROTECTION` (build ≥ 19041). | **Linux action:** Evaluate as false for Linux (content protection is not supported via standard Linux desktop APIs). |
| `main.js:221-224` | Sets `winOptions.type = 'toolbar'` on Windows to apply `WS_EX_TOOLWINDOW` (hides from Alt+Tab / Taskbar). | **Linux action:** Do not set `type = 'toolbar'` on Linux (causes unwanted window manager behaviors in X11/Mutter/KWin). Standard `skipTaskbar: true` applies `_NET_WM_STATE_SKIP_TASKBAR` and `_NET_WM_STATE_SKIP_PAGER` on X11. |
| `main.js:231-238` | Calls `win.setContentProtection(true)` on Windows and macOS. | **Linux action:** No-op or call guarded. Electron on Linux does not implement hardware/compositor capture exclusion. Document that content protection is not available on Linux. |
| `main.js:242` | Calls `win.setHiddenInMissionControl(true)` on macOS. | **Linux action:** No-op on Linux. |
| `main.js:263-267` | Emits in-app warning on Windows builds < 19041 regarding capture visibility. | **Linux action:** Emit a Linux-specific info status or document during onboarding that Linux windows remain visible in screen shares. |
| `main.js:516-522` | Formats screen capture error message based on platform (`darwin`, `win32`, fallback). | **Linux action:** Update fallback error message to mention X11 / Wayland PipeWire / `xdg-desktop-portal` permissions when running on Linux. |
| `main.js:616-619` | `ipcMain.handle('platform:info')` returns platform metadata to renderer. | **Linux action:** Returns `{ platform: 'linux', winBuild: 0, winSupportsContentProtection: false }`. |
| `main.js:710-716` | `getPermissionStatus()` bypasses macOS TCC checks on non-Darwin (`{ mic: 'granted', screen: 'granted' }`). | **Linux action:** Keep non-Darwin behavior. Linux permissions are handled at the device/subsystem level (ALSA/PulseAudio/PipeWire/Portal), not via Electron `systemPreferences`. |
| `main.js:718-737` | `requestPermissions()` prompts macOS TCC permissions. | **Linux action:** Returns `true` immediately on Linux. |
| `main.js:766` | Calls `app.dock.hide()` on macOS. | **Linux action:** No-op on Linux (`app.dock` is undefined). |
| `main.js:776-784` | `session.defaultSession.setDisplayMediaRequestHandler`: sets `request.audio = true` on Windows, `request.audio = 'loopback'` on macOS. | **Linux action:** On Linux, `request.audio = 'loopback'` or `request.audio = true` depending on PipeWire loopback capturer. Default to `request.audio = true` for PipeWire/Portal compatibility. |
| `main.js:809-811` | Sets `process.title = 'MicrosoftEdgeUpdate'` on Windows. | **Linux action:** Keep standard app naming; no process-masquerading tricks. |
| `main.js:813-821` | Gate launch on macOS permission check window. | **Linux action:** Launches `launchApp()` directly on Linux. |
| `preload.js:2` | Exposes `platform` string to renderer via `cue.platform`. | **Linux action:** Already platform-agnostic (`process.platform` returns `'linux'`). |
| `src/screen.js:1-21` | Uses `desktopCapturer.getSources({ types: ['screen'] })`. | **Linux action:** Works on X11 out of the box; works on Wayland via `xdg-desktop-portal` ScreenCast + PipeWire. |
| `src/whisper-runtime-manifest.js` | Defines `linux-x64` and `linux-arm64` tarball targets with SHA256 hashes. | **Linux action:** Already fully configured with pinned whisper.cpp 1.9.1 releases and checksums. |
| `src/whisper-runtime.js` | Resolves runtime executable path per platform. | **Linux action:** Already supports Linux path resolution. |
| `src/whisper-server-session.js:201-211` | `_buildRuntimeEnvironment()` sets `LD_LIBRARY_PATH` on Linux. | **Linux action:** Already configures `LD_LIBRARY_PATH` correctly for Linux sidecar process. |
| `scripts/prepare-whisper-runtime.js` | Downloads, unpacks tar.gz, materializes symlinks, runs `chmod 0o755`. | **Linux action:** Fully verified and working on Linux. |
| `scripts/verify-whisper-runtime.js` | Spawns `whisper-server --help` with `LD_LIBRARY_PATH`. | **Linux action:** Verified working on Linux. |
| `scripts/rename-electron.js:9` | Windows-only postinstall PE patcher (`if (process.platform !== 'win32') process.exit(0);`). | **Linux action:** Exits cleanly on Linux without modifications. |
| `vendor/app-link/lib/paths.js:11-21, 48-60` | Resolves `XDG_STATE_HOME || ~/.local/state/publik` and Unix domain sockets (`.sock`). | **Linux action:** Fully implemented and compatible with Linux standards. |
| `renderer/renderer.js:6-7` | Defines `isWindows` and `isMac`. | **Linux action:** Define `isLinux = cue.platform === 'linux'`. Update shortcut strings (`Ctrl+` instead of `⌘`) and onboarding text. |
| `renderer/renderer.js:1645-1659` | Onboarding dialogs and settings deep-links (`ms-settings:`, `x-apple.systempreferences:`). | **Linux action:** On Linux, display generic desktop guidance (e.g. "Check system sound and screen sharing settings in your desktop environment") instead of broken protocol URIs. |

---

## 2. Per-Feature Assessment

| Feature | Verdict | Rationale & Technical Details |
|---|---|---|
| **Screenshot Capture** (`desktopCapturer`) | **Supported** | • **X11:** Electron `desktopCapturer.getSources({ types: ['screen'] })` uses native X11 screen capture APIs; works reliably without extra dependencies.<br>• **Wayland:** Routes through `xdg-desktop-portal` (`org.freedesktop.portal.ScreenCast`) and PipeWire. Supported out of the box in Electron 33+. Requires desktop portal package for the running compositor (`xdg-desktop-portal-gnome`, `xdg-desktop-portal-kde`, or `xdg-desktop-portal-wlr`). |
| **Your-Mic Capture** (`getUserMedia`) | **Supported** | • Standard Web Audio API and `AudioWorklet` implementation in Chromium/Electron.<br>• Routes cleanly through PulseAudio, PipeWire (`pipewire-pulse`), or ALSA on all major Linux distributions.<br>• Zero platform-specific code needed in renderer. |
| **Meeting Audio / "Them" Channel** (`getDisplayMedia` loopback) | **Partially Supported** | • **Wayland + PipeWire:** `getDisplayMedia({ video: true, audio: true })` uses PipeWire loopback stream provided by the `xdg-desktop-portal` ScreenCast interface (portal v4+).<br>• **X11 / Pure PulseAudio / ALSA:** Chromium lacks an automatic system-audio loopback virtual device without PipeWire. Capturing meeting audio on legacy X11/PulseAudio requires user configuration of a monitor source (e.g., via `pavucontrol` or PulseAudio null sink).<br>• **Recommendation:** Document PipeWire as a prerequisite for seamless meeting-audio loopback; report absence gracefully when no loopback audio track is returned. |
| **Local whisper.cpp Transcription** | **Supported** | • `src/whisper-runtime-manifest.js` already pins verified `linux-x64` (`whisper-bin-ubuntu-x64.tar.gz`) and `linux-arm64` (`whisper-bin-ubuntu-arm64.tar.gz`) release artifacts.<br>• `scripts/prepare-whisper-runtime.js` unpacks archive, resolves internal dynamic library symlinks, copies `libggml*.so` / `libwhisper.so`, and marks binary executable (`0o755`).<br>• `src/whisper-server-session.js` sets `LD_LIBRARY_PATH` to the runtime directory when spawning the server.<br>• Verified end-to-end: runtime extraction and execution smoke tests pass cleanly on Linux. |
| **Global Shortcuts** (`Ctrl+Enter`, `Ctrl+H`, `Ctrl+Shift+X`) | **Partially Supported** | • **X11:** Electron's `globalShortcut` module relies on `XGrabKey`, which functions globally across all applications and window managers.<br>• **Wayland:** Wayland security model prevents arbitrary background key snooping. On modern desktop environments (GNOME 44+, KDE Plasma 5.27+), Electron registers via `org.freedesktop.portal.GlobalShortcuts`. On compositors lacking portal shortcut backends (e.g., standard wlroots/Sway without desktop-portal configuration), global shortcuts fail.<br>• **Recommendation:** Guard shortcut registration failures (already handled via `shortcutState`), log diagnostics, and allow in-app UI triggers as fallback. |
| **Content Protection / Capture Exclusion** | **Not Supported** | • **Scope Compliance:** Per standard OS/compositor API boundaries, no standard Linux mechanism exists equivalent to Windows `WDA_EXCLUDEFROMCAPTURE` or macOS `NSWindowSharingNone`.<br>• **X11:** Root window buffer is shared across all X11 clients; X11 protocol does not support selective window capture exclusion.<br>• **Wayland:** Compositor manages buffer composition. Neither `xdg-shell` nor common compositor protocols expose an unprivileged application API for excluding a surface from screen recording.<br>• **Recommendation:** Treat as a clean no-op in code; do not attempt process-hiding or frame-hooking tricks. Explicitly document in `README.md` and onboarding that Linux overlays are visible in screen shares. |
| **Packaging & Distribution** | **Supported** | • `package.json` contains `dist:linux` (`x64`) and `dist:linux:arm64` targeting `AppImage`.<br>• `electron-builder.cjs` has `linux: { target: ['AppImage'], category: 'Utility' }`.<br>• `scripts/after-pack.js` correctly builds Linux whisper runtime when `CUE_BUNDLE_WHISPER=1`.<br>• **Required Additions:** Add Linux PNG icon assets in `build-resources/icons/` (standard sizes: 16, 32, 48, 64, 128, 256, 512) or `build-resources/icon.png` to avoid default Electron logo on desktop launchers. |

---

## 3. Sequencing Recommendation

```
Phase 1: Zero-Risk Baseline (Already working / Verified)
  ├── Local whisper.cpp runtime prep & execution (linux-x64, linux-arm64)
  ├── Microphone capture (getUserMedia + AudioWorklet)
  ├── LLM provider streaming (OpenAI, Anthropic, Gemini, Custom)
  └── AppLink local IPC (Unix sockets under ~/.local/state/publik)

Phase 2: Core Linux Desktop UX & Packaging (Safe, High-Value Wins)
  ├── Screenshot capture validation (desktopCapturer on X11 & Wayland)
  ├── Renderer UI platform normalization (display "Ctrl+" hints on Linux)
  ├── Onboarding flow adaptations (Linux-friendly permission guidance)
  ├── Content protection no-op handling & status messaging
  └── Packaging assets (Linux PNG icons, .desktop category, AppImage verification)

Phase 3: Extended Audio & Shortcut Matrix (High-Uncertainty Items)
  ├── Meeting-audio capture via PipeWire / getDisplayMedia
  ├── Test matrix on GNOME (Wayland + X11), KDE (Wayland + X11), and wlroots
  └── Global shortcuts validation (XGrabKey vs GlobalShortcuts portal)

Phase 4: Documentation & Release
  ├── Capability matrix in README.md (honest disclosure of Linux capabilities)
  ├── CI workflow integration (.github/workflows/release.yml linux build verification)
  └── Maintainer review & PR submission
```

---

## 4. Open Questions for the Maintainer

1. **Packaging Formats:**
   - Currently, `electron-builder.cjs` and `package.json` specify `AppImage` for `x64` and `arm64`.
   - *Question:* Should `.deb`, `.rpm`, or `.tar.gz` targets be added alongside AppImage in the default `dist:linux` script, or is AppImage the preferred single deliverable for initial Linux support?

2. **Acceptance of Degraded Capabilities:**
   - On Linux, content protection (window hiding in screen shares) cannot be supported via standard APIs, and meeting audio loopback requires a PipeWire-enabled desktop.
   - *Question:* Is shipping Linux support with an explicit "Capabilities by Platform" table (documenting full screen/mic/AI support, optional PipeWire meeting audio, and no capture exclusion) acceptable for the initial PR?

3. **Chromium Ozone / Wayland Switches:**
   - Under pure Wayland sessions, Electron applications sometimes benefit from `--enable-features=UseOzonePlatform --ozone-platform=auto`.
   - *Question:* Should `cue` automatically set ozone platform flags in `main.js` when `XDG_SESSION_TYPE === 'wayland'`, or should this remain delegated to the user's environment / desktop launcher arguments?

4. **Onboarding Action Buttons:**
   - On Windows and macOS, the onboarding wizard provides deep-link buttons (`ms-settings:...`, `x-apple.systempreferences:...`). Linux desktops lack a universal settings URI scheme.
   - *Question:* Is replacing the buttons with descriptive guidance text on Linux the preferred UX, or should we detect specific desktop environments (e.g. `gnome-control-center`, `systemsettings`) to open settings conditionally?
