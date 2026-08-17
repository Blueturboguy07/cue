# Cue — System Architecture & Design

## 1. High-Level Architecture

Cue is an Electron desktop application running in a dual-process model (Main + Renderer) engineered for low latency, zero UI blocking, and screen-sharing invisibility.

```
                  ┌──────────────────────────────────────────────┐
                  │                 User Desktop                 │
                  │   [Zoom/Meet/Browser]      [LeetCode/IDE]    │
                  └───────────────┬──────────────────────┬───────┘
                                  │ (System Audio)       │ (Screen)
                                  ▼                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                             Renderer Process                               │
│  • Transparent Frameless Overlay Window (NSWindowSharingNone)              │
│  • getUserMedia (Mic Audio) ──┐                                            │
│  • getDisplayMedia (System) ──┴─► WebAudio VAD ──► IPC Stream              │
│  • UI Event Loop (Composer, Actions, Shortcuts, Settings)                  │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │ IPC (mic:pcm, system:pcm, ask)
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                               Main Process                                 │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐ │
│  │   Screen Capture     │  │   Speech Pipeline    │  │   LLM Controller  │ │
│  │ • native screencap   │  │ • local whisper.cpp  │  │ • Google GenAI    │ │
│  │ • desktopCapturer    │  │ • cloud STT fallback │  │ • Claude / OpenAI │ │
│  └──────────┬───────────┘  └──────────┬───────────┘  └─────────┬─────────┘ │
│             │                         │                        │           │
│             └─────────────────────────┼────────────────────────┘           │
│                                       ▼                                    │
│                           Context Assembly & Stream                        │
│                 (Resume + STAR Stories + Screen + Prompt)                  │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ Token Stream (llm:token)
                                        ▼
                                  Live Overlay UI
```

---

## 2. Core Subsystems

### 2.1 Stealth & Content Protection
* **Window Configuration:** The overlay window uses `alwaysOnTop: true`, `transparent: true`, `frame: false`, `skipTaskbar: true`, and window level set to `'screen-saver'` on macOS.
* **Content Protection:** `win.setContentProtection(true)` sets `NSWindowSharingNone` at the macOS Cocoa level. This prevents screen-sharing utilities (Zoom, Google Meet, Microsoft Teams, Discord, QuickTime Screen Recording) from capturing or broadcasting the Cue overlay.

### 2.2 Audio Ingestion & STT Pipeline
1. **Dual Audio Streams:**
   * **You Channel (Mic):** Captured via `navigator.mediaDevices.getUserMedia({ audio: true })`.
   * **Them Channel (System Audio Loopback):** Captured via `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`.
2. **Voice Activity Detection (VAD):**
   * Computes Root Mean Square (RMS) energy in real time.
   * Discards silence to conserve tokens and battery.
3. **Transcription Routing:**
   * **Local Mode (Default):** Streams mono 16kHz 16-bit PCM WAV chunks to `whisper-server` (C++ binary running locally on port 8080 with Metal GPU acceleration).
   * **Cloud Fallback:** Routes to Google Gemini multimodal batch STT or OpenAI Realtime WebSocket when cloud provider is selected.

### 2.3 Visual Capture Engine (`src/screen.js`)
* **Primary Engine (macOS):** Spawns `/usr/sbin/screencapture -x -t png <temp_path>` directly. Captures native retina display resolution in under 50ms without ScreenCaptureKit throttling.
* **Fallback Engine:** Electron `desktopCapturer.getSources({ types: ['screen'] })`.
* **Modes Requiring Screen:**
  * `leetcode`: Triggers screenshot, parses coding problem, outputs approach, solution code, and complexity analysis.
  * `assist`: Triggers screenshot + transcript history for broad interview copilot assistance.
  * `ask`: **Screen disabled** (`needsScreen: false`) to allow instant text querying without desktop capture overhead.

### 2.4 LLM Streaming & Self-Healing Architecture (`src/llm.js`)
* **SDK Integration:** Directly invokes `@google/genai`, `@anthropic-ai/sdk`, or `openai` with streaming responses (`generateContentStream` / `chat.completions.create`).
* **Self-Healing Model Migration:** Automatically detects deprecated/retired models (e.g. `gemini-1.5-*`, `gemini-2.0-flash`, `gemini-2.5-flash`) and transparently migrates settings to `gemini-3.5-flash`.
* **Inactivity Watchdog:** A 20-second watchdog promise race aborts hung streams and prevents UI locking if provider network stalls.

---

## 3. IPC Channel Specification

| Channel | Direction | Type | Description |
|---|---|---|---|
| `ask` | Renderer → Main | send | Triggers LLM execution for a given mode (`assist`, `leetcode`, `say`, `ask`, `answerThis`) |
| `llm:start` | Main → Renderer | event | Emitted when LLM request begins |
| `llm:token` | Main → Renderer | event | Emitted with each streamed token |
| `llm:done` | Main → Renderer | event | Emitted when LLM stream finishes |
| `llm:error` | Main → Renderer | event | Emitted if an error or quota exhaustion occurs |
| `capture:toggle` | Renderer → Main | invoke | Toggles audio listening state on/off |
| `whisper:models` | Renderer → Main | invoke | Returns installed & downloadable local whisper models |
| `profile:pickDocument` | Renderer → Main | invoke | Opens native file dialog to parse PDF/DOCX resume |
| `app:quit` | Renderer → Main | send | Gracefully terminates the application |
