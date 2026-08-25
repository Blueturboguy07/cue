---
name: run-cue
description: Run, launch, drive, or screenshot the cue desktop app (Electron overlay). Use when asked to run/start cue, take a screenshot, toggle capture, or poke the running app.
---

# run-cue

cue is an Electron overlay app (mic + system-audio capture feeding STT/LLM helpers).
Driving it means launching the real app with a CDP debug port and poking the renderer
over WebSocket — **not** Playwright, **not** xdotool (Wayland kills synthetic input).

Agent path: `.claude/skills/run-cue/driver.mjs`. Paths below are relative to repo root.

## Prerequisites

- Node >= 22 (driver uses global `fetch` + `WebSocket`; node on this machine: v26)
- `npm install` (electron lands in node_modules)
- Optional, for the system-audio path: `pipewire-utils` (`pw-play`), `pactl`
- No xvfb needed on a real desktop session; the window shows on the user's screen

## Run (agent path)

```bash
node .claude/skills/run-cue/driver.mjs launch          # spawn app, wait for UI
node .claude/skills/run-cue/driver.mjs status          # pid + capture state
node .claude/skills/run-cue/driver.mjs click '#stop-btn'   # start/stop listening
node .claude/skills/run-cue/driver.mjs ss after        # -> /tmp/cue-after.png
node .claude/skills/run-cue/driver.mjs eval "window.cue.captureState()"
node .claude/skills/run-cue/driver.mjs logs            # last 40 lines of app log
node .claude/skills/run-cue/driver.mjs quit
```

Real flow verified this session: `launch` -> `click '#stop-btn'` -> check `logs` for
`system audio: AudioWorklet capturing loopback` -> `ss` -> `quit`.

### Verify a screenshot isn't blank

```bash
python3 -c "from PIL import Image; im=Image.open('/tmp/cue-after.png').convert('RGB'); print(len(im.getcolors(10**6)), 'colors')"
```

Thousands of colors = rendered UI (dark theme, bg ~rgb(19,22,28)). <10 = blank frame.

### System-audio loopback sanity (Linux)

Capture reads a `CueSystemAudio` remap source that maps the default sink's monitor.
It is silent when nothing plays — play a tone while capturing or you'll chase a
phantom bug:

```bash
python3 -c "
import math, struct, wave
sr=48000; amp=0.15
frames=b''.join(struct.pack('<hh', *([int(amp*32767*math.sin(2*math.pi*440*i/sr))]*2)) for i in range(sr*5))
w=wave.open('/tmp/tone.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(frames)"
pw-play /tmp/tone.wav &   # then click '#stop-btn' during playback
```

After quit, `pactl list short sources | grep cue_system` must be empty (will-quit
unloads the module).

## Run (human path)

`npm start` — window opens on the real desktop, Ctrl-C to stop. Useless headless;
the driver path above is the only scriptable one.

## Test

```bash
npm test          # node --test test/*.test.js
```

Known: `test/applink.test.js:98` fails on clean main as of 2026-08-25 — pre-existing,
unrelated to audio work.

## Gotchas

- **Wayland**: xdotool/wtype can't click another app's window. CDP over
  `--remote-debugging-port=9222` is the only reliable drive surface.
- **`--no-sandbox`** is required in this environment or the renderer dies at spawn.
- **Global shortcuts get taken over** while the app runs (Ctrl+Enter, Ctrl+H,
  Ctrl+Shift+X). Quit the app before registering anything else.
- **One instance at a time** — app-link keeps an instance file in
  `~/.local/state/publik`. The driver refuses a second launch; reuse or `quit` first.
- **No STT key configured** -> status line says "No transcription key set" and no
  transcripts appear, but capture + PCM routing still run. Don't read it as failure.
- **Fontconfig / gl_surface / dbus warnings** on stderr are noise; ignore.
- **Never `pkill -f <pattern>` where the pattern matches your own shell's command
  line** — it self-matches and kills your terminal. The driver's `quit` uses the pid
  file + `Browser.close` for exactly this reason.
- Screenshots are of the BrowserWindow only, not the whole desktop.

## Troubleshooting

- `no renderer page on port 9222` -> app not running, or died: check `logs`.
- `app died early` -> read `/tmp/cue-app.log`; most common cause is a second
  instance fighting over the app-link socket.
- `UI never rendered #stop-btn` -> renderer JS error; full log in `/tmp/cue-app.log`
  (ELECTRON_ENABLE_LOGGING is set by the driver).
- eval of `window.cue.*` returns null -> preload didn't run; page target found is
  probably a devtools window, not the renderer (driver matches on `renderer` in URL).
