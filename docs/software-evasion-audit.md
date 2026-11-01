# Software Evasion Audit: Cue (v0.2.5)

> Implementation update (2026-10-31): the first group of five changes follows the source-confirmed privacy priorities in [off-device-privacy-audit.md](off-device-privacy-audit.md#implementation-update--2026-10-31-increment-1): audio consent, capture lifecycle cleanup, shared session transitions, request cancellation, and recipient-bound opt-in notes. The historical percentages and platform detection claims below are estimates, not measured protection guarantees; this increment does not validate them. See the privacy audit for remaining work and receiver-test requirements.

Based on an audit of the current codebase (`cue`, version 0.2.5), the project is architected as an **out-of-process, passive AI teleprompter/overlay** (Era 5 in the evasion timeline).

Excluding all hardware-based vectors (such as HDMI splitters and microcontroller USB HIDs), the codebase implements approximately **38%** of the full software evasion playbook.

---

### Implementation Scorecard (Pure Software Evasion)

```
┌────────────────────────────────────────────────────────┬─────────────┬───────────┐
│ Evasion Strategy Domain                                │ Status      │ Score     │
├────────────────────────────────────────────────────────┼─────────────┼───────────┤
│ 1. Compositor & Display Invisibility (Screen Capture)  │ COMPLETE    │ 95% (8/8) │
│ 2. Out-of-Process Data Ingestion (Vision & Audio)      │ COMPLETE    │ 100% (5/5)│
│ 3. Process & Binary Masquerading (Windows TaskMgr)     │ PARTIAL     │ 45% (3/7) │
│ 4. Input Injection & Keystroke Dynamics                │ ABSENT      │ 0%  (0/4) │
│ 5. Anti-Lockdown / VM / Hypervisor Hardening           │ ABSENT      │ 0%  (0/4) │
│ 6. AI Code Stylometry & Biometric Countermeasures      │ ABSENT      │ 0%  (0/3) │
├────────────────────────────────────────────────────────┼─────────────┼───────────┤
│ OVERALL SOFTWARE PLAYBOOK IMPLEMENTATION               │ PARTIAL     │ ~38%      │
└────────────────────────────────────────────────────────┴─────────────┴───────────┘
```

---

## 1. What IS Implemented in the Codebase

The codebase implements the **Passive Invisible Overlay & Ambient Ingestion** strategies:

### A. Compositor & Window Invisibility (95% Complete)
The project handles operating system graphics pipelines and screen-capture exclusion across macOS and Windows:
* **`WDA_EXCLUDEFROMCAPTURE` / `NSWindowSharingNone`**:
  [main.js](../main.js#L328-L340) calls `win.setContentProtection(true)` conditionally for Windows 10 build 19041+ and macOS. It also checks `process.env.SESSIONNAME === 'Console'` to prevent rendering failures under remote/virtual sessions ([main.js](../main.js#L95)).
* **Alt-Tab & Taskbar Hiding (`WS_EX_TOOLWINDOW`)**:
  [main.js](../main.js#L307-L312) sets `winOptions.type = 'toolbar'` on Windows, applying `WS_EX_TOOLWINDOW` to remove the window from both the taskbar and `Alt+Tab`. On all platforms, it sets `skipTaskbar: true` ([main.js](../main.js#L296)).
* **Focus Retention & Non-Activating Panels**:
  [main.js](../main.js#L316-L318) configures `winOptions.type = 'panel'` on macOS (`NSPanel`), while [main.js](../main.js#L291) sets `acceptFirstMouse: true` and [main.js](../main.js#L360) invokes `win.showInactive()`. This ensures interacting with `cue` **does not steal focus or trigger `window.onblur`** in an active browser tab.
* **macOS Dock & Mission Control Suppression**:
  [main.js](../main.js#L1343) calls `app.dock.hide()`, making `cue` an accessory application, and [main.js](../main.js#L346-L347) calls `win.setVisibleOnAllWorkspaces(true)` and `win.setHiddenInMissionControl(true)`.

### B. Out-of-Process Data Ingestion (100% Complete)
* **Native Desktop Capture without DOM Probing**:
  [src/screen.js](../src/screen.js#L40-L58) calls macOS `/usr/sbin/screencapture` directly (and `desktopCapturer` on Windows). It never injects scripts into candidate browsers, preventing DOM mutation listeners from firing.
* **System Audio Loopback**:
  [main.js](../main.js#L37-L39) passes Chromium command-line switches `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride` to intercept remote audio streams natively without external software loopback drivers.
* **Local On-Device STT**:
  [src/local-whisper-transcriber.js](../src/local-whisper-transcriber.js) integrates local `whisper.cpp` binaries to transcribe speech locally, preventing external cloud network packets from being flagged by corporate or proctoring firewalls.

### C. Process Masquerading on Windows (45% Complete)
* **Executable Name & PE Header Spoofing**:
  [scripts/rename-electron.js](../scripts/rename-electron.js#L11-L43) renames `electron.exe` to `MicrosoftEdgeUpdate.exe` during `postinstall`.
* **Resource & Icon Tampering**:
  [scripts/rename-electron.js](../scripts/rename-electron.js#L51-L93) uses `resedit` to extract real Edge icons and patch the binary's PE version tables (`CompanyName` = "Microsoft Corporation", `FileDescription` = "Microsoft Edge Update") to deceive Task Manager.
* **Window Title Masking**:
  [main.js](../main.js#L357) and [main.js](../main.js#L361) set the window title to `"Microsoft Edge Update"`.

---

## 2. What is ABSENT from the Codebase

The remaining ~62% of the software playbook consists of active injection, virtualization hardening, and behavioral counter-biometrics that `cue` does not implement:

### A. Input Injection & Keystroke Simulation (0% Implemented)
* **No Auto-Typing**: There are no automation libraries (`nut.js`, `robotjs`, or OS event synthesis). The candidate must manually read the code from the glass overlay and type it out.
* **No Keystroke Dynamics Generation**: No Inter-Key Interval (IKI) randomization, dwell-time synthesis, or simulated flight-time modeling to counter platforms that measure typing speed.
* **No Codeplayer Timeline Deception**: `cue` does not simulate organic programming trajectories (such as generating deliberate typos, backspaces, incremental test runs, or skeletal drafting).

### B. Anti-Lockdown & Process Evasion (0% Implemented)
* **Electron Child Process Footprint**: While the main executable is renamed on Windows, `cue` launches standard Chromium child processes (`--type=renderer`, `--type=gpu-process`, `--type=utility`). Lockdown browsers scanning the process tree (e.g., HackerRank Desktop App) can identify these command-line flags and loaded modules (`node.dll`).
* **macOS Process Exposure**: On macOS, process masquerading is completely absent. The bundle is named `cue.app` and registers under standard Electron bundle identifiers.
* **Anti-Anti-Cheat / Process Unhooking**: `cue` has no mechanisms to detect whether a proctoring binary (such as `Proctorio`, `Honorlock`, or `SafeExamBrowser`) is active or inspecting its memory space.
* **Virtual Machine / Hypervisor Cloaking**: [main.js](../main.js#L341-L343) deliberately *disables* content protection on VMs or RDP sessions to keep the window visible to the user, rather than masking hypervisor flags (`CPUID` bit 31, WMI queries).

### C. AI Stylometry & Code De-Watermarking (0% Implemented)
* **Standard LLM Code Outputs**: In [src/prompts.js](../src/prompts.js#L233-L246), the `leetcode` prompt instructs the model to provide:
  > `(1) a one-line restatement, (2) a short approach, (3) a clean, correct, idiomatic solution in a fenced code block... (4) time and space complexity.`
  This generates textbook LLM solutions. It does not instruct the model to alter variable naming conventions, introduce colloquial developer habits, or strip canonical AI formatting, leaving the output vulnerable to AST Winnowing (MOSS) and HackerRank’s GenAI ML detection models.
* **No Anti-Saccadic Teleprompter Layout**: Text is rendered in standard paragraph and code blocks ([renderer/index.html](../renderer/index.html)). It does not paginate or structure text to prevent horizontal saccadic eye movements.

---

## 3. How Platforms Detect the Current Codebase

When evaluating `cue` against current assessment environments:

| Proctoring Environment | Detection Risk | Primary Detection Vector |
| :--- | :--- | :--- |
| **TestGorilla (Pure Web)** | **Low to Moderate** | Screen-share hiding works via `WDA_EXCLUDEFROMCAPTURE`. However, periodic **webcam snapshots** will capture the candidate's gaze drifting toward the overlay, and **time-to-solution ratios** may trigger behavioral tier flags. |
| **HackerRank (Web Standard/Secure)** | **Moderate** | Evades `blur` tracking via `type: 'panel'`. However, final code submissions are evaluated by **MOSS AST matching** and the **GenAI ML Classifier**, which flag textbook LLM output. |
| **HackerRank (Desktop App Mode)** | **High (Fatal)** | The native client enumerates running processes via `CreateToolhelp32Snapshot`/`libproc`. It flags `cue.app` on macOS, Chromium child flags on Windows, or the presence of a window styled with `WDA_EXCLUDEFROMCAPTURE`. |

