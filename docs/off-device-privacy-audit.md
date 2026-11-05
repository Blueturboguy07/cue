# Cue: off-device exposure audit and patch plan

Audit date: 2026-10-28. Source baseline: `d62f5a7`, including the existing uncommitted macOS `type: 'panel'` change in `main.js`. Package version: 0.2.5; lockfile Electron version: 33.2.1.

Cue currently requests capture exclusion for its main window on selected platforms. That leaves several independent ways for information about Cue or its contents to reach another person or service. The highest-value work is to close capture lifecycle bugs, make protection status accurate, enforce explicit outbound-data choices, and repair integration permissions. Universal off-device undetectability is not an achievable release criterion.

The original deliverable was a source audit and implementation plan. The implementation update below records subsequent behavior changes. The existing macOS panel edit in `main.js` has been preserved. Platform claims and links are collected in [capture-platform-research.md](capture-platform-research.md).

## Implementation update — 2026-10-31, increment 1

Implemented five related controls from the first implementation sequence:

1. **F05 — Meeting audio Off:** both renderer and main deny capture on every platform unless the setting is explicitly `true`. Disabling it stops live renderer resources, rejects pending grants, drops system PCM, and cancels that channel's batch requests.
2. **F05 — Pending capture and teardown:** microphone and loopback starts reject stale grants and worklet completions; Stop releases tracks, contexts and handlers even when individual cleanup operations fail. Reload, renderer loss and window close stop the main session.
3. **F05/F04 — Shared capture transitions:** UI and AppLink use one main-process desired-state owner. Stop preempts pending model startup; starts serialize; obsolete requests cannot revive capture. The UI does not wait for media permission before accepting Stop. AppLink awaits the actual result.
4. **F06 — Request cancellation:** chat, batch STT and slide-caption transports receive abort signals; Stop and watchdogs cancel work and discard late results. Cancelled requests cannot continue provider/model fallback. Slide tracking cancellation also covers pending hash/full-frame capture, settings changes and clear. Transient caption failures can retry the same slide.
5. **F06 — Automatic notes consent:** off by default, with an Audio setting explaining the destination. New meetings record approval for the selected provider/endpoint fingerprint; historical or differently routed meetings cannot inherit it. Disabling/changing the recipient aborts notes. Clear suppresses notes now and during later catch-up. Notes record only the submitted turn count.

The permanent regression tests include deferred grants/model verification/screenshots, failed worklets, throwing cleanup, old callbacks across restart, transport cancellation and fallback suppression, a 1,000-toggle queue, and 1,600 seeded renderer operations. No real audio, screenshots, credentials or meeting contents were sent to providers in these tests.

Validation: `npm test` passes **382/382 tests**, including the existing local-socket integration tests (run with local socket access). JavaScript syntax checks and `git diff --check` pass. The existing `mic-double-start-harness.mjs` also reports one microphone pipeline for one activation. These are code-level checks; no live receiver capture or production egress observation was performed.

This is partial remediation of F04/F06, not an application-wide local-only policy or a complete privacy pause. Explicitly enabled automatic notes can start after End session. Cancellation cannot retract already delivered requests. Capture-backend and receiver behavior remain unverified. F01–F03, integration revocation (F10), outbound HTTPS/local-only enforcement (F08/F06), storage and IPC hardening remain open. The next group should address protection state, hidden window construction, owned secondary windows, and a distinct privacy pause.

## Implementation update — 2026-11-02, increment 2

Implemented the next four controls:

1. **F01 — Truthful protection status:** one window-policy owner records `requested`, `disabled`, `unsupported`, or `error` with bounded reason codes. Debug overrides are parsed explicitly; `CUE_NO_PROTECT=0` no longer disables the request. Linux, older Windows builds, remote/unknown Windows sessions and API errors stay distinct. Every state reports `verified:false`. Both pages have a persistent notice, and README capture guarantees have been corrected.
2. **F02/F03 — Shared hidden startup:** both constructors use `show:false`. Protection and navigation/popup restrictions are installed before loading. A window is shown only after load completion and acknowledgement that its privacy notice is ready. Per-load tokens reject stale acknowledgements across reload/crash, including while deliberately hidden. Recreated windows get their own state. OS-owned dialogs, indicators and external browser surfaces remain outside this policy.
3. **F04 — Collapse and Hide:** Collapse/Expand describes the existing layout action. Hide window is separate and leaves listening running. Ctrl/⌘+Shift+Space hides/restores owned windows; hiding is disabled if recovery cannot be registered. Passive startup/consent handling cannot undo a deliberate Hide.
4. **F04/F06 — Privacy pause:** a main-process gate blocks new capture and feature requests before cancelling active work. Pause aborts pending capture/model starts, chat, STT, slides, notes, gateway requests and model downloads; it suppresses notes and queued retries. Integrations cannot prompt or obtain slide captions across the pause boundary, and outstanding consent handlers are removed. Paused state persists through settings and requires explicit Resume; restoring the UI never restarts listening or cancelled requests. If recovery is unavailable, Pause still stops work and leaves the controls visible. A settings-write failure cannot prevent runtime cancellation.

Regression coverage includes both owned-window lifecycles, the platform/override/error matrix, stale readiness and initialization responses, rejected IPC senders/subframes, a 1,000-reload hidden-window stress loop, pause/restore/resume races, note suppression, pending consent, active downloads, and cancellation during gateway response-body reads. All fixtures are synthetic; no meeting content or real credentials are sent to providers.

Validation: `npm test` passes **420/420 tests** with local socket access, including all 382 tests from the first increment. JavaScript syntax checks, `git diff --check`, and the existing microphone double-start harness pass. These checks exercise application policy and lifecycle behavior, not receiver-side capture exclusion.

Strict sharing mode, a safe dedicated surface for choosing whether to continue without protection, integration-session revocation (F10), application-wide outbound/local-only policy, storage migration and broader IPC/sandbox hardening remain open. This increment does not certify capture exclusion or local-only behavior. Live receiver capture and production egress validation have not been performed. Already delivered requests cannot be retracted.

## Scope and confidence

Reviewed the main process, preload bridge, renderer windows and audio lifecycle, screen/slide capture, chat and speech-provider routing, meeting persistence, Publik provisioning, AppLink transport/consent/diagnostics, Whisper sidecar/downloads, packaging identity and relevant build/debug workflows. Searched first-party runtime code for additional network, capture, notification, clipboard, process, storage, and navigation surfaces.

Evidence labels below distinguish **source-confirmed behavior**, **reproduced logic failures**, and **capture-dependent risks**. Reproductions use synthetic data and mocked capture, except the AppLink revocation check, which uses an isolated real local socket. No real audio, screenshot, credential, or meeting content was sent to a service.

This was not a live Zoom/Meet receiver test, packet capture, binary/dependency penetration test, managed-device assessment, or proof of all possible detection methods. Those limits are material: a source-level protection call cannot establish what a remote receiver sees. The diagnosis skill's reproduce/fix cycle was applied to discrete failures where a runnable seam existed; platform capture risks remain unverified hypotheses with explicit validation steps. No fixes are claimed.

## Who can observe what

| Observer | Potential evidence | Boundary and appropriate response |
| --- | --- | --- |
| Ordinary meeting participant | Shared pixels, shared audio, camera view/reflections, a user-opened dialog or OS panel, interaction effects | Validate the actual received stream; share the narrowest suitable surface; provide complete hide/pause controls. Joining a call alone is not evidence of access to the sender's process list. |
| Ordinary website | Its own focus/visibility/input events; media the user grants it | These signals do not identify Cue. Do not promise that an overlay prevents all focus changes. |
| AI provider or Publik gateway | Submitted prompts, screenshots, audio/transcripts, supplied profile context, authenticated requests and usage; Publik install metadata | Reduce data sent, show destinations, provide an enforced local mode. A service receiving requests necessarily observes that use. |
| Network operator | Destination IPs, timing and volume; domains depending on DNS/TLS/proxy setup | HTTPS protects content from a passive observer, not all metadata. A hostname or traffic pattern alone does not reliably identify Cue. Plain HTTP is a separate content-exposure defect. |
| Authorized integration | Granted status/diagnostics, control actions, separately consented slide captions; potentially onward sharing by that integration | Least privilege, immediate revocation, opt-in availability and redaction. Cue cannot establish what another application does with granted data from this repo alone. |
| Remote administrator with endpoint software | Capabilities may include process/app inventory, files, device activity and privileged capture, depending on installed tools and policy | Screen exclusion is not a boundary against authorized endpoint management. Use supported deployment policies; do not design process camouflage, monitoring bypasses or suppressed OS indicators. |
| Backup/support recipient | Settings, transcript history, debug logs or recordings if those artifacts are copied or uploaded | Minimize retained content; provide deliberate export, retention and deletion controls. Local storage is not automatically an off-device transmission. |

Browser, OS-indicator, Windows-pipe and TLS distinctions are sourced in the [platform research](capture-platform-research.md). Physical cameras and human inferences cannot be eliminated by a window flag. No evidence was found of a dedicated meeting-participant detection API, a meeting bot joining calls, or an automatic upload of AppLink diagnostics by Cue itself.

## Findings

### F01 — Protection capability and actual protection state are conflated — P0

**Source-confirmed; capture outcome untested.** [main.js](../main.js#L63) checks the Windows build and `SESSIONNAME`, then [conditionally applies protection](../main.js#L322). Protection is skipped on Linux, Windows builds below 19041, Windows sessions where `SESSIONNAME` is absent or not exactly `Console`, and whenever `CUE_NO_PROTECT` is a nonempty string. Thus `CUE_NO_PROTECT=0` also disables it. The Windows session value is a heuristic, not verified session classification.

`platform:info` only reports OS/build capability ([main.js:1124](../main.js#L1124)); it omits bypass, session, API result and capture-backend uncertainty. Some missing-protection cases get transient status text, others only console output. Status text disappears after 11 seconds ([renderer.js:1229](../renderer/renderer.js#L1229)).

The README claims older Windows gets a black box, although Cue skips the call on those builds; it also claims exclusion from every Windows capture path and automatic Meet/Teams/QuickTime protection. Neither the implementation nor primary platform evidence supports those guarantees. macOS ScreenCaptureKit visibility is a documented platform limitation, not something this audit can solve with another Electron flag. Zoom's documented filtering setting is not a certification for Cue.

**Patch:** introduce one main-process protection-state owner with states such as `requested`, `disabled`, `unsupported`, and `error`, plus reason codes. Keep receiver verification separate and scoped to a tested configuration. Parse the debug override explicitly and display a persistent notice when active. Surface uncertainty before sensitive content appears. In a user-selected strict sharing mode, keep sensitive windows hidden when protection is unavailable; let the user choose whether to proceed. Do not force the Windows flag back on in a remote session and recreate the repository-recorded visibility regression.

**Acceptance:** deterministic policy cases for every skip branch, unknown sessions, false-like environment values, API errors and window recreation. No status may claim a capture was verified merely because the API was called. Do not assume latest Electron's `isContentProtected()` exists in 33.2.1 or proves receiver exclusion.

### F02 — Windows are constructed visible before protection is installed — P0

**Source-confirmed ordering hazard; no leaked frame reproduced.** Both BrowserWindow constructors omit `show:false`; Electron 33 defaults `show:true`. The main window is constructed at [main.js:320](../main.js#L320), then protected, and eventually shown again in `did-finish-load`. This leaves a possible initial window/chrome/presence interval. It does not prove private text was painted in that interval.

**Patch:** construct all Cue-owned windows hidden, install policy/navigation restrictions first, and only show once content and protection-state handling are ready. Route reopen, reload and recovery through the same lifecycle. A first-show order fix still cannot defeat an unsupported capture backend.

**Acceptance:** lifecycle integration tests assert protect/configure-before-show ordering; receiver recordings cover startup while sharing, reload, crash recovery and reopen. Include a deliberately unprotected negative control.

### F03 — Secondary windows and external surfaces remain exposed — P1

**Source-confirmed scope gap; remote inclusion depends on capture.** The permissions window has `skipTaskbar:false` and no content-protection call ([main.js:1305](../main.js#L1305)). Native model/profile file pickers ([main.js:1114](../main.js#L1114), [1185](../main.js#L1185)), the AppLink fallback message box ([applink.js:77](../src/applink.js#L77)), opened settings/browser pages, OS privacy panels, share-source pickers and switcher thumbnails are distinct surfaces. Protecting the overlay does not establish their exclusion.

**Patch:** use the common window policy for owned permission/help/error windows; keep ordinary in-app dialogs inside those windows when appropriate. Offer setup before sharing and defer nonessential file/browser flows while strict sharing mode is active. Tell the user when an action opens an external surface. Preserve OS-owned consent UI and indicators.

**Acceptance:** inspect each surface from the receiving device, including file names, permission text, menus, title/tooltips, taskbar/dock, source-picker entries and previews. Record presence evidence separately from leaked content.

### F04 — Hide means collapse; there is no complete privacy pause — P1

**Source-confirmed.** [renderer.js:554](../renderer/renderer.js#L554) toggles a CSS class and closes the sidebar. The toolbar/window remains, capture continues and cloud work can continue. Opacity is intentionally clamped above zero. The global Hide shortcut invokes this same collapse action.

**Patch:** label the current action Collapse. Add explicit Hide window and Pause session actions, with a tested way to restore the UI. A privacy pause must hide Cue-owned windows as configured, stop input tracks and polling, cancel pending starts and outbound work, and suppress automatic note generation until the user chooses to resume it. An integration consent request must not unexpectedly reveal a deliberately hidden window; deny or queue it for explicit user attention while paused.

**Acceptance:** pause during pending media permission, transcription, slide capture, an LLM stream and integration requests. No late callback may re-open capture or restart work. Make clear that cancellation cannot retract bytes already delivered.

### F05 — Meeting-audio Off/Stop does not reliably control capture — P0

**Two reproduced logic failures.** Both the renderer and main display-media handler enforce `meetingAudio` only on macOS ([renderer.js:773](../renderer/renderer.js#L773), [main.js:1392](../main.js#L1392)). A synthetic Windows run with the setting false still requests system audio; the same conditional also leaves Linux ungated.

Separately, `startSystemAudio()` awaits `getDisplayMedia()` without a generation check, while `stopSystemAudio()` only stops an already stored stream ([renderer.js:785](../renderer/renderer.js#L785), [833](../renderer/renderer.js#L833)). Resolving a pending grant after Stop leaves a live stream in the probe. This proves a lifecycle defect; it does not establish that every End-session click triggers it. The normal button awaits capture before toggling main state, so integrated tests must cover rapid clicks and external/start-stop transitions too.

Saving Meeting audio Off also does not explicitly stop an existing renderer stream. Continued capture can prolong OS indicators and collect unnecessary audio even when main currently drops PCM.

**Patch:** enforce Off on every platform at both permission and renderer boundaries; invalidate pending starts on Stop, settings changes and teardown; stop every track returned by a stale request. Recheck after every asynchronous setup step. Serialize button and AppLink capture transitions through the same desired-state owner. Apply setting changes to live capture immediately.

**Acceptance:** deferred-grant tests, Off on every platform, rapid start/stop/start, failed AudioWorklet setup, stop during initialization, and settings changed mid-session. Assert all tracks and contexts close, pending calls cannot revive capture, and no PCM leaves the stopped session.

### F06 — Local speech mode can still generate cloud transcript and screenshot requests — P0

**Source-confirmed, with existing meeting-memory tests exercising note generation.** Local Whisper correctly avoids a cloud STT fallback. However, [main.js:749](../main.js#L749) refreshes notes when capture stops; [1354](../main.js#L1354) supplies the selected chat provider and runs catch-up notes on launch. [meeting-memory.js:46](../src/meeting-memory.js#L46) submits transcripts of at least four turns. Clearing the transcript invokes `end()`, which can also generate notes. An incomplete meeting may therefore be sent to the chat provider selected at a later launch.

Opt-in slide tracking captures and captions screens through that same chat provider ([main.js:547](../main.js#L547), [599](../main.js#L599)). Selecting Local under Audio does not restrict chat, notes or slide traffic. Feature and slide watchdogs use `Promise.race` without cancelling the underlying request ([main.js:556](../main.js#L556), [863](../main.js#L863)); stopped or timed-out work can remain in flight.

**Patch:** separate local transcription from an application-wide local-only policy. Enforce that policy in every request entrypoint, including notes, catch-up, slides, wallet/provisioning and downloads. Gate automatic notes on an explicit setting and the meeting's permitted destination; re-approval is needed before moving saved meeting content to a new provider. Propagate cancellation signals and session generations through streaming, batch STT and captioning. Give Clear, Delete meeting, End session and Privacy pause distinct semantics.

**Acceptance:** seeded four-turn meetings across stop/clear/restart/provider change. In local-only mode, observe zero non-loopback outbound connections with models preinstalled, including failure/retry/catch-up paths. A local gateway that itself forwards to a cloud is outside Cue's process boundary and must not be labeled end-to-end local without separate verification.

### F07 — Cloud recipients and install metadata exceed the screen-share threat model — P1

**Source-confirmed.** Publik receives an install ID, app identity/version, OS/version, architecture and hostname on provisioning ([main.js:912](../main.js#L912), [publik.js:141](../src/publik.js#L141)); provisioning follows disclosure acceptance. Successful Publik answers schedule wallet requests. Direct chat routes and custom/Anthropic relays receive their selected request content ([llm.js:500](../src/llm.js#L500)).

Speech is chosen independently: Auto prefers Deepgram/OpenAI streaming and can fall back to an OpenAI/Groq/Gemini batch chain ([stt-streaming.js:611](../src/stt-streaming.js#L611), [stt.js:106](../src/stt.js#L106), [main.js:479](../main.js#L479)). Profile/job-description terms can enter STT vocabulary hints ([stt.js:24](../src/stt.js#L24)). Chat prompts include selected background fields. Hugging Face/CDN model downloads and GitHub build-time runtime downloads are additional network destinations, not meeting uploads.

**Patch:** show separate chat, speech, notes, slides and integration destinations. Offer an explicit fallback-recipient allowlist rather than deriving consent from every stored key. Omit the hostname by default or use a user-supplied device label; disclose remaining install metadata and retain legitimate billing identity. Make download activity explicit. Correct README claims that conflict with the Publik path and transcript persistence.

**Acceptance:** fake transports record destination and payload categories for each feature, error, retry and provider selection. Verify selecting a provider does not grant unrelated stored-key recipients. Do not represent a VPN, renamed process, or encrypted request as making service use undetectable.

### F08 — Remote plaintext endpoints are accepted — P0

**Reproduced validation gap.** [openai-compatible.js:14](../src/openai-compatible.js#L14) accepts non-loopback `http://` URLs; the probe used the reserved `example.invalid` hostname without connecting. Publik's returned base URL also permits HTTP and arbitrary origins ([publik.js:190](../src/publik.js#L190)). Ollama and Anthropic relay paths need the same review rather than relying solely on the Custom validator.

**Patch:** require HTTPS for remote destinations; permit cleartext only for explicitly local loopback endpoints. Validate all endpoint settings and server-returned destinations consistently. Pin the packaged Publik gateway's approved origins, with a separate deliberate development override. Validate redirects before sending sensitive data or credentials to another origin; validate resolved addresses and redirects when enforcing local-only mode.

**Acceptance:** loopback IPv4/IPv6, remote HTTP, malformed/userinfo URLs, endpoint changes, same-origin redirects, cross-origin redirects and DNS/address changes. No request payload should be sent before policy validation. This does not remove HTTPS metadata or data visibility at the recipient.

### F09 — Screenshots capture a broad surface and can leave temporary files — P1

**Source-confirmed plus reproduced cleanup failure.** [screen.js:40](../src/screen.js#L40) writes a full-resolution PNG into the system temp directory through `screencapture`; the child-process error return precedes `finally`, so cleanup is never attempted on that branch. A mock subprocess error reproduced the missing cleanup. A crash can also leave artifacts. This is a conditional persistence issue, not evidence a real image was left during this audit.

Screenshots use a full display rather than a selected meeting region. Slide hashing uses `sources[0]`, while the non-macOS full capture prefers the primary display; the native macOS capture path has no explicit display selection ([main.js:533](../main.js#L533), [screen.js:60](../src/screen.js#L60)). On unsupported capture paths, Cue's own overlay may also be present in the frame it submits. Multi-display behavior requires measured validation.

**Patch:** add explicit screen/window/region selection shared by hash and full capture, preview the selection, and minimize unrelated content before transmission. Prefer an in-memory native capture path where supported. Otherwise use a private per-session temp directory, cleanup on all completion paths, and bounded startup cleanup of owned stale files. Audit multi-display outputs from the native command. Do not claim secure erasure from backups or SSD storage.

**Acceptance:** sensitive synthetic content outside the selected region never enters provider payloads; the hash and full frame refer to the same source; subprocess failure, missing image, extra display output, cancellation and stale-file recovery all have cleanup coverage.

### F10 — AppLink revocation leaves existing sessions authorized — P0

**Reproduced over an isolated real socket.** Cue's revoke action calls `link.consent.revoke()` ([applink.js:200](../src/applink.js#L200)). That deletes the saved decision ([consent.js:146](../vendor/app-link/lib/consent.js#L146)), while requests continue checking scopes cached on the connection ([server.js:339](../vendor/app-link/lib/server.js#L339)). The probe revoked a synthetic caller successfully, then still read state and invoked a harmless synthetic action on the same connection.

This integration is started automatically ([main.js:1402](../main.js#L1402)). Discovery advertises Cue identity; state is counts-only, and slide captions correctly require separate consent. However, caller identity is a same-user claim without peer verification. A local integration with granted access could transmit received data onward. No such onward transmission was observed here. Windows named pipes must not be called local-only merely because the listener uses `\\.\pipe\...`; effective remote access needs a Windows-specific review, as explained in the platform research.

**Patch:** invalidate active sessions immediately on revoke, recheck current authorization before each sensitive operation, and invalidate pending consent resolutions so they cannot restore a revoked grant. Add an integration enable/disable control and consider session-scoped consent for unverified callers. Keep separate slide approval. Review Unix permissions, Windows pipe ACL/remote-client rejection and sidecar origin/request authentication. Preserve the existing loopback-only Whisper binding and randomized request path; those do not authenticate a same-user process.

The code explicitly says the vendored AppLink library is maintained upstream ([applink.js:12](../src/applink.js#L12)). Fix the vendor behavior upstream and sync the pinned copy, or enforce an immediate app-level stop/restart/revoke adapter while that work lands.

**Acceptance:** revoke while connected, during a pending prompt and during an action; deny subsequent reads/actions without another grant. Disable must remove discovery and terminate sessions. Validate Windows pipe reachability/ACLs on Windows without assuming a remote vulnerability exists.

### F11 — Diagnostics redaction is incomplete — P1

**Reproduced redaction gap; no real credential leak observed.** The AppLink event ring filters known secret shapes ([ring-buffer.js:30](../vendor/app-link/lib/ring-buffer.js#L30)), but leaves a bare synthetic Publik-shaped credential untouched. Arbitrary custom API keys and sensitive free-text error payloads cannot be protected reliably by these patterns. Console logs bypass this filter; some capture logs include audio device labels ([renderer.js:698](../renderer/renderer.js#L698)). Diagnostics include a user-data path. Support/debug workflows can upload screenshots and logs from their test machines ([bugfix-lab.yml](../.github/workflows/bugfix-lab.yml)); that is distinct from automatic end-user telemetry.

**Patch:** use structured allowlisted error fields and redact configured secret values before both logging and diagnostic export. Avoid recording raw provider response bodies, prompts, transcripts, paths and device labels by default. Require deliberate content inclusion in support exports and test synthetic fixtures. Keep minimal non-content operational information useful for debugging.

**Acceptance:** fixtures for every supported key shape, arbitrary custom secrets, echoed request text, URLs, nested errors and stdout/stderr. Re-run diagnostics through the wire, not just the redaction helper.

### F12 — History and credential copies can travel through backups or support files — P1

**Source-confirmed local storage; off-device transmission conditional.** Settings and API keys are plaintext JSON, with an additional previous-state `.bak` copy ([settings-store-core.js:80](../src/settings-store-core.js#L80)). Only the Publik key is removed from the renderer view ([store.js:203](../src/store.js#L203)). `meetings.json` persists transcript content and summaries; its writer does not apply the settings store's explicit permissions/atomic-write handling ([meetings.js:21](../src/meetings.js#L21)). Clear transcript retains history and may trigger notes. Whether any of these paths are backed up or synchronized is not known from source.

**Patch:** move credentials to an OS-backed secret store, minimize their exposure to the renderer, and migrate all known plaintext backup/temp copies. Offer session-only history, a retention period, and a real Delete meeting action with clear scope. Apply private file permissions/appropriate Windows ACLs and atomic persistence to meetings. Make support exports content-free by default. Never promise encryption protects data from an already authorized process in the same unlocked user session.

**Acceptance:** deletion/credential removal covers main, backup, temporary and in-memory copies owned by Cue; crash/recovery does not resurrect deleted data; exports exclude content by default. Existing external backups need separately stated retention semantics.

### F13 — Focus, cursor, audio-device and physical cues need bounded claims — P2

**Source-confirmed interactions; remote inference unmeasured.** The existing macOS panel change and `showInactive()` are intended to reduce activation in some cases, but AppLink consent explicitly calls `app.focus({steal:true})` and `win.focus()` ([applink.js:60](../src/applink.js#L60)). Text entry, file dialogs, external links and dragged windows can change what the shared application does. Cursor shape/location and lost keyboard input may be visible even if overlay pixels are excluded. A page's focus or visibility signal does not establish which application caused it.

No dedicated Cue notification, text-to-speech or clipboard-write path was found in the runtime search. AudioWorklet paths do not intentionally play captured audio, and legacy processing uses a zero-gain sink. Device switching, Bluetooth profile changes, fan/load effects, shared system sounds, and physical reflections remain test cases rather than demonstrated Cue-specific identifiers.

**Patch:** keep passive UI non-disruptive; make text-entry/setup/consent transitions deliberate; avoid unnecessary background capture and work. Use ordinary pause controls and narrow sharing scope. Do not falsify website focus/visibility events, suppress indicators, or market behavioral signals as solved by a panel flag.

**Acceptance:** a benign test page logs its actual focus/visibility state while exercising click, drag, typing and shortcuts; receiver video/audio establishes the visible impact. Include Bluetooth/default-device changes and simultaneous meeting audio.

### F14 — Renderer and IPC hardening reduces accidental disclosure paths — P1

**Source-confirmed hardening gaps; no exploit demonstrated.** Windows have `contextIsolation:true` and `nodeIntegration:false`, which are useful defenses, but set `sandbox:false`. The preload exposes broad settings/capture/integration operations to both windows. Media grants are checked by permission name, not sender identity; the general `open-pane` handler passes arbitrary renderer-supplied URLs to `shell.openExternal`. No explicit navigation or new-window deny handlers were found. Main's IPC handlers generally do not validate the sender frame ([main.js:893](../main.js#L893), [1177](../main.js#L1177), [1363](../main.js#L1363); [preload.js](../preload.js)).

The renderer currently escapes generated Markdown and has a restrictive CSP. These gaps do not demonstrate remote code execution or a malicious webpage controlling Cue.

**Patch:** enable the renderer sandbox after compatibility checks, use minimal per-window preload bridges, validate sender frames and payload schemas, allow media only for trusted local renderer frames, deny unwanted navigation/popups, and allowlist external URL schemes/destinations. Preserve Publik's existing stricter outbound-link checks. Revalidate media permission behavior after each change.

**Acceptance:** untrusted frames and wrong windows cannot read credentials, grant integration access or start capture; hostile links/Markdown remain inert; normal permission and import flows still work.

### F15 — Identity camouflage provides no reliable privacy boundary — P2

**Source-confirmed.** Main titles/process naming impersonate Microsoft Edge Update ([main.js:357](../main.js#L357), [1428](../main.js#L1428)); the Windows postinstall script rewrites executable metadata and imports Edge icons ([rename-electron.js](../scripts/rename-electron.js)). Packaging and AppLink still identify Cue. This is not authenticated Microsoft provenance and does not protect screen content, network traffic or managed-device inventory. It also makes permission and diagnostic identity confusing.

**Patch:** restore consistent Cue identity, remove third-party vendor impersonation, and use normal signed/notarized distribution. Review an Electron upgrade separately, with version-specific capture and audio regression testing; do not assume a newer runtime fixes platform limits. Validate release builds, since development renaming and packaged artifacts can differ. Do not implement security-agent evasion, process concealment or traffic camouflage.

**Acceptance:** consistent app/window/helper/publisher identity, valid expected signatures, packaged-runtime verification and rerun receiver matrix. Signing is an integrity/distribution improvement, not invisibility.

## Implementation sequence

| Order | Deliverable and code boundary | Completion gate |
| --- | --- | --- |
| 1 | **Stop means stop:** F05, then F04/F06 cancellation. One capture-session owner for renderer/main/AppLink; pending-start generations and request abort signals. | Deferred grants, rapid toggles and Stop during requests cannot restart capture or enqueue cloud work. Privacy pause explicitly suppresses automatic notes. |
| 2 | **Trustworthy sharing behavior:** F01–F03/F04. A shared window lifecycle and protection-state module; persistent status; explicit hide and strict sharing mode; corrected claims. | Hidden construction and lifecycle tests pass. Unsupported/unknown paths never display a verified-protection claim. |
| 3 | **Repair integration authorization:** F10/F11. Immediate revocation and pending-prompt invalidation, integration toggle, structured redaction, upstream vendor sync. | The real-socket revocation probe changes from failure to pass; diagnostics remain useful without secrets/content. |
| 4 | **Control outbound data:** F06–F09. A shared outbound policy used by fetch, SDK HTTP and WebSocket paths; HTTPS/redirect validation; local-only enforcement; recipient-specific disclosure; source selection. | Fake-provider payload tests and isolated network observation pass, including notes/catch-up/downloads and provider failure paths. |
| 5 | **Minimize retained data and privileges:** F09/F11/F12/F14. Temp cleanup, credential storage/migration, retention/delete semantics, sender/navigation/sandbox restrictions. | Crash/recovery, deletion, permission and export tests pass without reviving removed content or breaking normal use. |
| 6 | **Release assurance:** F13/F15 and the receiver matrix. Consistent identity, signed builds, runtime upgrade evaluation, accurate support table. | Publish only exact tested configurations and known limitations; repeat after relevant OS/browser/meeting/runtime updates. |

These are separable patches; window-policy work can proceed independently of the media lifecycle fix. The outbound policy must cover background notes and slides before a local-only badge ships. Code tests are prerequisites to receiver testing, not substitutes for it.

## Required receiver and network validation

Use synthetic notes/credentials on a test machine and an independent receiving device/account. Record the received feed, rather than relying on Cue's own screenshot API or the sender preview. Test tab, application-window and entire-display sharing independently; audio scope can differ from video scope. Cover the exact supported Meet browsers and Zoom versions/modes, then Teams/OBS/native recording only if support will be claimed.

Include Windows local/remote/unknown-session cases, supported macOS capture backends, Linux unsupported status, multiple displays/DPI, first launch while already sharing, permissions, startup/reopen/crash, fullscreen, sleep/resume, settings/consent/import flows, Hide/Collapse/Pause, focus/input and microphone/system-audio stop races. For each case score separately: **private content**, **presence evidence**, **OS surfaces**, **input interference**, and **audio artifacts**. Record versions and negative controls. The expanded matrix is in [platform research](capture-platform-research.md).

For network validation, exercise cold/warm launch, idle, local/cloud transcription, each chat provider, Auto fallback, stop, clear, notes, restart catch-up, slides, integration enable/disable and model download. Record destination and data category without logging secrets or real content. Local-only acceptance requires zero non-loopback traffic from Cue and its managed sidecars in that test, with downloads completed beforehand. Test any separately managed local gateway's own egress independently.

## Checks performed

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm test` | 304 tests: 298 passed; 6 failed because the sandbox disallowed socket listeners. | Existing code-test baseline; not screen-share assurance. |
| Retry `test/applink.test.js` and `test/publik-provisioning.test.js` with isolated temp storage and local-socket permission | 17/17 passed, including all 6 blocked tests. | All 304 unique existing tests accounted for across the two runs; no remaining observed suite failure. |
| `node /tmp/cue-privacy-audit-probes.cjs` | Five expected privacy assertions failed. | Reproduced ignored Windows audio-Off, late capture after Stop, remote HTTP acceptance, missing error-path screenshot cleanup and incomplete key redaction. |
| `node /tmp/cue-applink-revocation-probe.cjs` | Revocation returned true; the same connection could still read and invoke the synthetic action. | Reproduced ineffective active-session revocation. |
| Official platform/specification review | Completed in the linked research note. | Defines API limits and required validation; does not certify a meeting-app configuration. |
| Live receiver capture / production network / managed endpoint | Not performed. | Remains an explicit release-validation requirement. |

The two temporary probes use synthetic fixtures and are retained under `/tmp` for this workspace session; they are not shipped application code or permanent regression tests. Move each relevant case into the proper test seam when implementing its patch. The existing suite passing while these probes fail is a coverage gap, not contradictory evidence.
