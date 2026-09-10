# Anker desktop companion

The `feat/anker-private-sync` branch adds optional upload-only synchronization with Anker. It keeps capture in Electron and review in the platform. The upstream desktop code remains GPL-3.0-or-later; retain its license and corresponding source when distributing binaries.

## Run from source

```sh
git clone --branch feat/anker-private-sync https://github.com/345668/Call-Intelligence.git
cd Call-Intelligence
npm ci
npm run prepare:whisper  # only if using local transcription from source
npm start
```

Node 22.12 or later is required. Use the normal OS permission flow. The app now identifies itself as Anker Call Intelligence; the former executable masquerading postinstall has been removed.

## Connect and sync

1. Sign into Anker and select your workspace. Open **Call Intelligence** (founder/fund manager) or **Call notes** (LP).
2. Enter a device name and create a connection key. Copy the once-visible key into the desktop **Settings → Anker sync** tab. Never paste a GitHub PAT, AI key or account password there.
3. Choose **Connect**. Check the displayed account, workspace and persona. Keys expire after 90 days and can be revoked from Anker.
4. Clear the previous transcript, then record the new conversation using your selected speech provider. Local Whisper does not send audio to a cloud fallback. Get the appropriate permission before capturing/sharing conversations.
5. Stop listening and wait for transcription. Preview the current transcript, name the call, acknowledge permission and choose **Queue this capture**.
6. Choose **Upload queued calls**. Successful imports disappear from the local queue. Failed imports remain with retry status and capped backoff. The same import ID is used when a response is lost.
7. Open Anker, refresh your call library, review the transcript and explicitly request platform analysis if wanted. Anker's configured provider is separate from the desktop speech/chat provider. Review notes and any follow-up draft before further action.

Only queued transcript text and its title/import ID are sent by sync. Audio, screenshots, resume/profile context and provider credentials are excluded. No background upload runs. The endpoint is fixed to `https://www.an-ker.de`; redirects are rejected. This branch therefore requires the matching platform API to be deployed at that origin for a real sync test.

## Offline behavior and failure recovery

The Anker key and queued transcripts are stored in `anker-sync.enc` under Electron's user-data directory, using safeStorage encryption. Sync refuses insecure storage, including Linux `basic_text`. If the OS credential store is unavailable, restore/unlock it; the app does not fall back to plaintext or overwrite an unreadable queue. This encryption applies to the new Anker queue/key; existing desktop AI provider keys/profile data still use the original settings storage.

- No connection: capture and local assistance still work. Already queued calls remain locally after disconnect; new calls require a connection before queueing.
- Revoked/expired key or removed membership: upload fails and preserves the queue. Reconnect to the same account/workspace using a new key.
- Different account/workspace with queued calls: switching is blocked. Finish uploading or remove those local queued copies first.
- 400/409/413: import is blocked for review; no server overwrite occurs. Resolve the content/size issue in the platform or create a new reviewed capture.
- Network/server error: queue stays on disk; retry after the displayed backoff. No false successful sync state.
- More than 60,000 characters: sync refuses a partial transcript. Review smaller sections in Anker's paste workflow. The live capture remains in memory until cleared/quit; queued text is durable.
- Removing a local queued copy does not remove any server record. Deleting a call in Anker does not delete a local capture. Disconnect removes the stored sync key but does not revoke it server-side; revoke the device in Anker too when retiring a machine.

## Native builds and private delivery

Use the existing electron-builder targets. Set `CUE_BUNDLE_WHISPER=1` when building a companion that includes local transcription; runtime preparation/verification must finish before packaging. macOS needs valid Developer ID signing and notarization; Windows needs the publisher's signing certificate before production distribution. This development environment has not produced or validated signed installers.

The platform can stream approved binaries from a dedicated private Vercel Blob store after sign-in. Do not use public GitHub release URLs as the private delivery boundary. Publish immutable versioned objects and record their exact SHA-256, byte size, platform and version in the platform release manifest only after native verification. Include this source branch/version and GPL license with the release.

Before distribution, test capture, microphone/system-audio permissions, secure storage, stop/drain/preview, restart/offline retry, membership removal/revocation, duplicate response loss and all supported OS/architecture targets. Screen-share exclusion is best-effort and must not be advertised as guaranteed.
