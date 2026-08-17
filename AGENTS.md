# AI Agent Instructions & Operating Rules

> **CRITICAL INSTRUCTIONS FOR ALL AI AGENTS & IDEs (Claude, Cursor, Windsurf, Copilot, Antigravity, etc.)**
> 
> Whenever you work on the **Cue** codebase, you MUST adhere to the following mandatory rules and protocols.

---

## 📋 Rule 1: Always Update `CHANGELOG.md`
* Whenever you add a feature, refactor logic, or fix a bug, you **must document the change in [`CHANGELOG.md`](./CHANGELOG.md)** with a summary of the problem, root cause, and technical solution.
* Never leave changes unlogged.

---

## 🧪 Rule 2: Run Tests Before Any Deployment
* Before syncing changes or closing a task, run the test suite:
  ```bash
  npm test
  ```
* All 130 tests **must pass**. If a test fails due to a changed requirement or updated model name, update the corresponding test in `test/` cleanly.

---

## 🔐 Rule 3: Apple Developer Code Signing Requirement
* The standalone macOS app at `/Applications/cue.app` is bound to the developer's official Apple Developer identity:
  `Apple Development: milantiwari2003@gmail.com (9KYMR669PW)`
* Whenever you sync source changes into `/Applications/cue.app`, you **must re-sign the bundle**:
  ```bash
  codesign --force --deep --options runtime \
    --entitlements build-resources/entitlements.mac.plist \
    --sign "Apple Development: milantiwari2003@gmail.com (9KYMR669PW)" \
    /Applications/cue.app
  ```
* **NEVER sign with ad-hoc (`-`) signature** on macOS Sequoia, as ad-hoc signatures break macOS TCC Screen Recording and Microphone authorization.

---

## ⚡ Rule 4: Model Stability & Self-Healing
* For Google Gemini, always use `gemini-3.5-flash` as the stable default.
* If interacting with `src/llm.js`, respect the `DEAD_GEMINI_MODEL_RE` regex pattern that transparently migrates deprecated models without crashing user sessions.
* Keep `fast` and `smart` model fields aligned in `src/store.js`.

---

## 🖥️ Rule 5: Screen Capture Integrity
* In `src/screen.js`, prefer the native macOS `/usr/sbin/screencapture` pipeline for retina display capture.
* Ensure `ask` mode (typing text in composer) maintains `needsScreen: false` so text questions do not trigger unwanted screen permission dialogs.

---

## 🗂️ Rule 6: Directory Structure Integrity
* The primary source repository is located at:
  `/Users/milan/Projects/cue`
* User application data and API keys live at:
  `/Users/milan/Library/Application Support/cue/cue-data.json`
* **Never overwrite or delete `cue-data.json`** during code updates.
