# Cue — Changelog & Iteration Record

All notable technical updates, fixes, and architecture iterations are documented in this file.

---

## [0.2.2-custom.3] — 2026-08-18

### 🚀 Major Fixes & Enhancements
1. **Local Whisper.cpp Apple Silicon Runtime:**
   * Compiled native `whisper.cpp` v1.9.1 binary (`whisper-server`) with Apple Silicon Metal GPU acceleration (`darwin-arm64`).
   * Bundled the runtime directly inside `/Applications/cue.app/Contents/Resources/whisper-runtime/`.
   * Updated `scripts/prepare-whisper-runtime.js` to locate standalone CMake and fixed the upstream GitHub source archive SHA256 integrity hash.
2. **Apple Developer Code Signing & TCC Permanence:**
   * Signed `/Applications/cue.app` using the developer's valid Apple Developer Certificate (`Apple Development: milantiwari2003@gmail.com (9KYMR669PW)`) with macOS Hardened Runtime.
   * Eliminated repeated macOS Sequoia Screen Recording and Microphone authorization prompts.
3. **Screen Capture Engine Upgrade:**
   * Replaced fragile Electron `desktopCapturer` ScreenCaptureKit thumbnail implementation on macOS with native `/usr/sbin/screencapture` pipeline.
   * Eliminates 0-byte thumbnail failures and brings capture latency to < 50ms.
4. **Prompt & Mode Optimization:**
   * Updated `ask` mode (typed text prompt) in `src/prompts.js` to `needsScreen: false`.
   * Typing questions in the text box no longer triggers unnecessary screenshot captures or screen permissions.
5. **Model Migration to Gemini 3.5 Flash:**
   * Updated default Gemini model configuration in `src/llm.js`, `src/store.js`, and `cue-data.json` to `gemini-3.5-flash`.
   * Validated live vision recognition for LeetCode code synthesis without high-demand 503 errors.
6. **Native File Dialog Fix:**
   * Removed parent window attachment from `dialog.showOpenDialog` in `main.js`.
   * Fixed non-responsive "Import PDF/DOCX" buttons in Profile settings.
7. **Workspace Migration:**
   * Transferred repository from `/Users/milan/cue` to `/Users/milan/Projects/cue`.
8. **Gemini 429 & 503 Auto-Retry & Backoff:**
   * Added exponential backoff retry and automatic model fallback in `src/llm.js` so transient 429 rate limits and 503 high demand spikes self-heal transparently without throwing modal errors.
9. **Settings Modal UI & Layout Redesign:**
   * Replaced non-wrapping flex row for provider selection with a 4-column responsive grid (2 rows of 4 clean chips).
   * Eliminated ugly native white horizontal and vertical scrollbars using custom thin dark-mode scrollbars and hidden overflow on the tab bar.
   * Redesigned the tab bar as a segmented macOS glass pill track with concise tab labels (`🔑 Keys`, `🎙️ Audio`, `📄 Profile`, `🎯 Prep`, `✨ Style`, `💬 Q&A`).
   * Aligned all form fields and inputs in uniform 2-column grids with consistent padding, borders, and accent focus rings.
   * Enhanced macOS glassmorphism depth with 40px backdrop blur, subtle 1px border highlight, and 18px border radius.

---

## [0.2.2-custom.2] — 2026-08-17

### Fixed
* Fixed 404 error caused by retired `gemini-2.5-flash` model references.
* Fixed non-functional Quit (`✕`) button in toolbar by wiring event listener in renderer.
* Fixed STT fallback routing to prioritize Gemini STT over exhausted OpenAI keys.
* Unlocked permissions continue gate in `renderer/permissions.html`.

---

## [0.2.2] — 2026-08-17

### Initial Setup
* Initial clean clone and install of Cue overlay codebase.
* Packaged native `arm64` macOS application at `/Applications/cue.app`.
* Validated 130 native test runner unit tests.
