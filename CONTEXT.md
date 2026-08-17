# Cue — Project Context & State

## Overview
**Cue** is an open-source, cross-platform, stealth AI copilot designed for technical interviews, coding assessments (e.g. LeetCode), and meetings. It operates as a transparent, always-on-top, invisible overlay that captures three distinct inputs:
1. **Screen Capture** (Active window / display screenshot for coding problem solving).
2. **Microphone Audio** ("You" channel for the candidate's speech).
3. **System Audio** ("Them" channel for the interviewer/remote participants via audio loopback).

These inputs are processed locally and routed to Large Language Models (Gemini, Claude, OpenAI, Ollama, etc.) to deliver real-time, context-aware answers grounded in the user's resume, STAR stories, and target job description.

---

## Project Locations on This Machine
* **Source Repository:** `/Users/milan/Projects/cue`
* **Installed macOS Standalone App:** `/Applications/cue.app`
* **Persistent App Data & Configuration:** `/Users/milan/Library/Application Support/cue` (`cue-data.json`, local whisper models, history).

---

## Current Technology Stack
* **Framework:** Electron 33.2.1 (Node.js 24.14.0 runtime)
* **Frontend:** Vanilla HTML5, Modern CSS3, Vanilla ES6+ JavaScript (no heavy frontend frameworks for minimal latency and stealth)
* **Speech-to-Text (STT):**
  * **Local:** `whisper.cpp` v1.9.1 compiled with native Apple Silicon Metal GPU acceleration (`darwin-arm64`).
  * **Cloud:** Google Gemini (Batch WAV), OpenAI Realtime, Deepgram, Groq.
* **LLM Providers:** Google Gemini (`@google/genai`), Anthropic Claude (`@anthropic-ai/sdk`), OpenAI (`openai`), Ollama (Local), Groq, MiniMax, Azure AI Foundry.
* **Screen Capture:** macOS Native `/usr/sbin/screencapture` pipeline (with fallback to Electron `desktopCapturer`).
* **Code Signing:** Official Apple Developer Certificate (`Apple Development: milantiwari2003@gmail.com (9KYMR669PW)`) with macOS Hardened Runtime.

---

## Key Files & Structure
```
/Users/milan/Projects/cue
├── main.js                  # Electron main process (lifecycle, IPC, shortcuts, window management)
├── preload.js               # Context bridge exposing safe IPC methods to renderer
├── package.json             # NPM configuration and dependencies
├── electron-builder.cjs     # App packaging and entitlements configuration
├── build-resources/         # Entitlements (entitlements.mac.plist), icons, assets
├── renderer/                # User interface
│   ├── index.html           # Overlay UI layout (toolbar, composer, status, settings modal)
│   ├── styles.css           # Styling, animations, transparent glass theme
│   ├── renderer.js          # UI controller, audio stream capture, state management
│   └── permissions.html     # Onboarding permissions gate
├── src/                     # Core business logic
│   ├── llm.js               # LLM client abstractions (Gemini, OpenAI, Claude, Ollama, etc.)
│   ├── prompts.js           # Feature modes (assist, say, leetcode, followup, recap, ask)
│   ├── screen.js            # High-resolution screenshot capture engine
│   ├── store.js             # Settings persistence & schema migration
│   ├── stt.js               # Batch speech-to-text fallback chain
│   ├── stt-streaming.js     # Realtime streaming speech-to-text
│   ├── whisper-runtime.js   # Local whisper.cpp binary loader
│   ├── whisper-manager.js   # Local whisper model downloader and integrity verifier
│   └── profile-context.js   # Resume / STAR stories context builder
├── scripts/                 # Build & prep scripts
│   └── prepare-whisper-runtime.js # Compiles whisper.cpp from source
└── test/                    # 130 native Node test runner unit tests
```

---

## Active AI Configuration
* **Active LLM Provider:** Google Gemini
* **Default Models:** `fast: "gemini-3.5-flash"`, `smart: "gemini-3.5-flash"`
* **STT Provider:** Local Whisper (`base.en` / Metal GPU) with Gemini Cloud fallback
