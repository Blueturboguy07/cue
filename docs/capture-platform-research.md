# Capture protection: platform evidence

Verified 2026-10-28. This is a primary-source review, not a successful Zoom/Meet capture test. The checkout's lockfile resolves Electron **33.2.1**. Current Electron documentation can describe behavior newer than this runtime.

## Established limits

| Surface | Evidence | Consequence for Cue |
| --- | --- | --- |
| Electron capture flag | The version-33 API maps `setContentProtection` to macOS `NSWindowSharingNone` and Windows `WDA_EXCLUDEFROMCAPTURE`; the API is labeled macOS/Windows. [Pinned Electron API](https://raw.githubusercontent.com/electron/electron/v33.2.1/docs/api/base-window.md) | Treat it as a platform request, not proof of what a remote participant receives. Linux has no guarantee through this Electron API. |
| Windows | Microsoft specifies an owned top-level window, requires DWM composition, and limits protection to specific public capture APIs. It expressly disclaims a security/DRM guarantee. Windows 10 version 2004 introduced true exclusion; older versions interpret the flag as `WDA_MONITOR`, leaving a contentless window. [Microsoft API contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) | Do not claim exclusion from every capture method. Check the actual code's policy separately: Cue can skip the flag altogether, which is different from the OS black-window fallback. |
| macOS modern capture | Electron maintainers reproduced visibility with native macOS recording, distinguished legacy CoreGraphics from ScreenCaptureKit, and closed the report as expected behavior. [Electron issue #48258, maintainer comments](https://github.com/electron/electron/issues/48258) | A successful legacy screenshot does not prove protection against ScreenCaptureKit. The cited maintainer evidence does **not** establish a universal macOS 15.4 cutoff or prove a particular current Meet/Zoom build's backend. |
| Zoom capture modes | Zoom describes its filtering modes in terms of excluding **Zoom's own windows**, and also documents a Windows secure-window-sharing mode. [Zoom advanced sharing settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063824) | The setting name alone does not certify third-party Cue exclusion. Record the exact Zoom version, mode, share scope, OS, and receiving-side result. |
| Window creation | Electron 33 defaults `show` and `focusable` to true. Its macOS `panel` option adds a nonactivating-panel style and permits fullscreen/all-spaces presentation. [Pinned constructor options](https://raw.githubusercontent.com/electron/electron/v33.2.1/docs/api/structures/base-window-options.md) | Omitting `show:false` creates a visibility interval before a subsequent protection call. This establishes an ordering hazard, not a reproduced leaked frame. The panel option does not document a promise that another browser never fires focus/visibility events. |
| Newer Electron behavior | Current docs discuss exclusion taking effect on a later desktop composition and changed Windows remote-session behavior. They also show a case where `isContentProtected()` remains true while exclusion is disabled. [Current BaseWindow documentation](https://www.electronjs.org/docs/latest/api/base-window#winsetcontentprotectionenable-macos-windows) | Do not transplant current remote-session assumptions into Electron 33 without version-specific verification. A true getter is configuration evidence, not receiver-side capture proof. |

## What a website or remote participant can observe

The standard screen-capture API exposes a user-selected monitor, window, or browser surface. Selection and permission happen for each request; granted permission is not persistent. The audio source can differ from the video source, including system audio accompanying a single window. This supports testing video and audio independently and preferring the narrowest sharing scope appropriate to the task. It does not establish a process-enumeration capability for an ordinary webpage. That last statement is an inference about this API's documented surface, not a claim that browser fingerprinting or vulnerabilities are impossible. [W3C Screen Capture specification](https://www.w3.org/TR/screen-capture/)

A page can observe its own `document.hasFocus()` and `visibilityState`/`visibilitychange`. Focus concerns where keyboard events are routed; visibility is a separate state determined by the browser. These signals do not identify which other application caused a change. Do not equate every focus loss with a visibility change or with proven Cue detection. [WHATWG focus API](https://html.spec.whatwg.org/multipage/interaction.html#dom-document-hasfocus), [WHATWG page visibility](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility)

An installed extension with a registered native messaging host has capabilities beyond an ordinary website. Native messaging is explicitly a bridge between an extension and a native application. Browser-only assumptions therefore do not cover an endpoint with extra native software or administrative agents. [Chrome native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

The reviewed platform documentation does not establish that a remote meeting participant receives a list of all running apps merely by joining a call. Conversely, captured pixels, shared system audio, and user-opened OS surfaces can expose information without a dedicated app-detection API. These are separate threat models.

## OS-owned surfaces

macOS displays microphone and system-audio privacy indicators; Control Center may identify the app using them. Windows displays a taskbar microphone indicator while an app uses the microphone. These establish local OS-visible evidence. Whether a particular indicator, tooltip, Control Center panel, permission dialog, or task switcher is present in the remote stream depends on the capture configuration and needs receiver-side testing. Cue's window flag does not establish protection for separately owned OS surfaces. [Apple Control Center guide](https://support.apple.com/en-euro/guide/mac-help/mchl50f94f8f/27/mac/27), [Microsoft camera/microphone privacy guide](https://support.microsoft.com/en-gb/windows/privacy/windows-camera-microphone-and-privacy)

Appropriate remediation is to make capture state accurate, request permission before a sharing session when practical, stop unused capture promptly, and offer clear user controls. Do not suppress consent indicators or describe them as guaranteed remotely visible. An external camera remains outside software screen-capture protection; Microsoft explicitly lists photography as an example of its protection boundary. [Microsoft API contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)

## Proposed validation matrix

These are proposed checks, **not completed test results**. Use synthetic notes and credentials, an independent receiving device/account, and a recording of what the receiver sees. Save exact OS build, Cue commit, packaged/source build, Electron version, browser/meeting version, display setup, capture mode, and test timestamps.

| Dimension | Cases |
| --- | --- |
| OS/runtime | Supported macOS releases, including modern ScreenCaptureKit paths; Windows 11 and any supported Windows 10 build; Linux X11/Wayland explicitly marked unsupported for this flag; current Electron 33 and any upgrade candidate. |
| Capture implementation | Meet in each supported browser; Zoom desktop modes individually; Teams, native recording, and OBS if claimed supported. Never infer one result from another. |
| Scope | Browser tab, app window, entire display, multi-display sharing; local and remote desktop sessions separately. |
| Lifecycle | Already-sharing startup; first-run permissions; overlay reopen; crash/reload; fullscreen transitions; display disconnect/reconnect; sleep/resume. |
| Surfaces | Overlay, settings, help, consent, native file dialogs, external browser links, error dialogs, task switcher, OS privacy controls, and share-source picker. Test each actual exposed surface. |
| Interaction | Passive viewing, clicking, text entry, dragging, global shortcuts, and explicit consent prompts. Observe focus changes in a test page without falsifying its events. |
| Audio | Microphone, system loopback, mute, stop, capture failures, and shared system audio; verify no continuing capture after stop. |
| Negative control | Protection disabled in a controlled test, proving the receiver would actually see the test window. A passing result without this control is weak evidence. |

Score content exposure and presence evidence separately: a blank rectangle can protect note text while still revealing a window. Record uncertain/unsupported combinations as such. Recheck after OS, browser, meeting-app, graphics-driver, or Electron changes. This matrix is an engineering recommendation derived from the documented boundaries above.

## Claims this review cannot support

- Universal invisibility, or protection from every screen recorder and remote-control product.
- Guaranteed Meet, Teams, or QuickTime exclusion without a measured version-specific result.
- Guaranteed Cue exclusion merely because Zoom's filtering option is selected.
- The absence of page blur/visibility events solely because Cue uses `type:'panel'`.
- The claim that privacy indicators are always sent to every participant.
- Hiding an installed application's identity or activity from authorized endpoint management, or preventing all inferences from user behavior, camera video, or network traffic.

No third-party meeting session, recipient capture, or endpoint-management integration was exercised in this research pass.

## Additional transport boundaries

**Windows AppLink IPC is not proven local-only.** `vendor/app-link/lib/paths.js` chooses a Windows named-pipe name; `lib/server.js` passes it to `net.createServer().listen()` without an application-defined Windows security descriptor. Node documents this as named-pipe IPC, which by itself provides no remote-exclusion assurance. Microsoft documents cross-machine named-pipe access, a remote-client rejection mode, and DACL restrictions. Treat remote reachability as conditional on the Windows Server/SMB configuration, firewall, authentication, effective ACL, and actual runtime behavior. This review did not inspect a running Windows pipe or prove unauthorized remote access. The patch plan should require explicit local/session isolation and verification, not infer it from the path syntax. [Node IPC documentation](https://nodejs.org/api/net.html#ipc-support), [Microsoft named pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes), [remote-client modes](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea), [pipe access control](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

**HTTPS protects content, not all metadata.** Properly authenticated TLS keeps request/response content between its endpoints; a passive network observer does not ordinarily receive cleartext prompts or screenshots. Packet sizes and timing remain observable. Destination IPs remain visible on a direct connection, and domain visibility depends on plaintext DNS, SNI/ECH support, and the observer's position; encrypted DNS and ECH are not universal anonymity guarantees. A configured gateway or trusted TLS-intercepting proxy is a different endpoint/trust boundary, not merely a passive observer. Do not claim provider attribution from generic encrypted traffic alone, or claim endpoint encryption hides traffic from every administrator. [TLS 1.3 confidentiality and traffic-analysis limits, RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html#section-1), [ECH scope and DNS/IP limits, RFC 9849](https://www.rfc-editor.org/rfc/rfc9849.html#section-1)
