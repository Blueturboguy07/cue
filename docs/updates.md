# Updates

cue updates itself on macOS and Windows. Linux stays on manual download (the AppImage from the Releases
page). The code is `publik-updater.cjs` (the Electron part) and `publik-update-verify.cjs` (the signature
check). Both files come from the publik Electron updater template (Blueturboguy07/surfcam, `docs/updates.md`).
cue's copy adds two things, both generic: an optional `show` function for the messages, and the test-build
lock (see "Test builds and the proof").

## How it works

1. The app asks `https://publikhq.com/api/updates/cue/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch (before the sign-in), every 24 hours, and when you click **Check for Updates…** at the
   bottom of **Settings**. cue has no menu bar (no Dock icon, a frameless window), so the item is there.
2. The app verifies the signature with the publik update public key, which is in `publik-update-verify.cjs`.
   If the signature is missing or wrong, the app stops there. It downloads nothing.
3. The feed must name this app (`publikApp: cue`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names. It refuses the file if its sha512 is not the
   one in the signed feed. Windows downloads the NSIS installer (`cue-win-x64.exe`). macOS downloads the zip
   of its architecture (the file whose name has `arm64` on Apple silicon, the other one on Intel), and
   Squirrel.Mac also refuses an app that does not satisfy the code signature of the running app (same
   bundle ID `com.cue.overlay`, same Developer ID). This keeps the microphone and screen-recording grants.
5. The app asks: "cue X is ready to install. Restart now?" **Later** installs the update when you quit.
   The app never restarts by itself.

The messages appear inside cue's window, like the assistant access request: an app with no Dock icon
cannot bring a native dialog forward. A message that comes before the window exists waits for it.
A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks. The CI workflows set it.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/cue/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/cue/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/cue/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/cue/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The base URL must not carry a query string: electron-updater copies the base query onto every file URL.
- The feed lists ABSOLUTE GitHub asset URLs. electron-updater's generic provider resolves each URL with
  `new URL(url, base)`, so an absolute URL stays as it is. The app downloads the installer from GitHub,
  not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.
- A release tag must not contain `arm64`: electron-updater takes any file whose URL contains `arm64` for
  an arm64 file.

A mac feed file looks like this (`scripts/publik-update-feed.cjs write` makes it):

```yaml
version: '0.2.16'
publikApp: 'cue'
files:
  - url: 'https://github.com/Blueturboguy07/cue/releases/download/v0.2.16/cue-0.2.16-mac-x64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/cue/releases/download/v0.2.16/cue-0.2.16-mac-arm64.zip'
    sha512: '<base64>'
    size: 123456789
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

`latest.yml` has one file, `cue-win-x64.exe`. Its name carries no version, so the feed script checks the
version in the installer's version resource (ProductVersion) instead.

The `.sig` file is a minisign signature of the feed file. The app accepts these forms:

| Made with | Algorithm | File form |
|---|---|---|
| `tauri signer sign` (what `scripts/publik-update-feed.cjs` uses) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text, wrapped in base64 |
| `minisign -S` (minisign 0.8 and later) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text |
| `minisign -S -l` (legacy) | `Ed`: Ed25519 over the file | minisign text |

Electron's crypto has no BLAKE2b-512, so the app computes it with the `blakejs` package. The trusted comment
must name the file (`file:latest.yml` or `file:latest-mac.yml`). tauri and minisign write that by default;
do not replace it with `-t`.

## Cut a release

1. Set the new version in `package.json`. Commit.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. `release.yml` builds the Windows installer
   and the Linux AppImages, puts them on the release, then runs `update-feed.yml`, which adds `latest.yml`
   and its `.sig`.
3. Make the two signed macOS zips on the release Mac (the Developer ID is in its keychain):
   `MAC_SIGN=1 npm run dist:mac` (with the `APPLE_*` notarization variables) makes the signed, notarized
   `dist/cue-X.Y.Z-mac-x64.zip` and `dist/cue-X.Y.Z-mac-arm64.zip`. Or take the two unsigned apps of
   **Actions › publik build** (`publik-build.yml`), sign, notarize and staple each one, then zip it:
   `ditto -c -k --sequesterRsrc --keepParent cue.app cue-X.Y.Z-mac-<x64|arm64>.zip`.
   Squirrel.Mac installs from these zips.
4. Upload the mac zips: `gh release upload vX.Y.Z cue-X.Y.Z-mac-x64.zip cue-X.Y.Z-mac-arm64.zip`.
5. Make the mac feed: run **Actions › Update feed** with the tag (or
   `gh workflow run update-feed.yml -f tag=vX.Y.Z`). It adds `latest-mac.yml` and its `.sig`. It adds only
   missing feed files. Use **force** after you replace an installer file.
6. Check that the release holds the four feed files.

For a publik release (a draft that publik scans): put all the installer files on the draft, then run
**Update feed** for the draft's tag BEFORE the scan. The scan then sees the feed files too. When the draft
is published, `release.yml` sees that the release already has files and does nothing (no feed job either).

The update key is needed only in step 5 (and 2): `update-feed.yml` reads the repo secrets
`PUBLIK_UPDATE_KEY` and `PUBLIK_UPDATE_KEY_PASSWORD`. `publik-build.yml` builds the installers and does
not need the key. Without CI, run the same script on a Mac that has the key in its keychain:

```sh
PUBLIK_UPDATE_KEY="$(security find-generic-password -s publik-update-key -a mann-private -w)" \
PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s publik-update-key -a mann-password -w)" \
node scripts/publik-update-feed.cjs release --tag vX.Y.Z --app cue --repo Blueturboguy07/cue
```

A build made with the `dir` target (publik-build.yml) has no `resources/app-update.yml`; the app then
writes the same small file in its own folder (`publik-app-update.yml` in the user data folder).

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`, `latest-mac.yml.sig`).
   Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER version (for example 0.2.17 with the code of 0.2.15), with its
   feed. Apps that installed the bad version update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key (the `RW…` line of `new.key.pub`, base64-decoded) to `PUBLIK_UPDATE_PUBLIC_KEYS`,
   next to the old key. Release that version, signed with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

Users who skip the transition release cannot verify feeds that the new key signs. They must install
again by hand. If the old private key leaks, do the same steps at once. Until users have the new list,
a leaked key lets an attacker sign a feed. On Windows the installer is not code-signed, so the key is
the only protection there. On macOS, Squirrel.Mac still requires the Developer ID signature.

## Test builds and the proof

`.github/workflows/updater-proof.yml` proves the updater on GitHub's Windows runner and on two macOS
runners (Apple silicon and Intel). It builds two test versions, N and N+1, with
`"publikUpdaterTest": true` in `package.json`. Only a test build reads these environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/cue/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

The test hook runs first in `app.whenReady()`, so a test run never reaches the sign-in gate, the permission
requests, the window, the microphone or a screenshot (`test/updater-wiring.test.js` checks the order).
A test build started WITHOUT `PUBLIK_UPDATER_TEST` exits at once: it never runs cue itself. The proof
checks that, checks that no cue process is left running after any start or after the install, blocks
publikhq.com on the runner, and on macOS reads the TCC log: cue must not ask for the microphone, the camera
or the screen.

Test versions are `0.0.0-updtest.*`. A test feed that the real key signs is therefore never newer than a
real release. The proof puts N+1 on a prerelease with a `v0.0.0-updtest.*` tag and deletes it at the end.
The proof also runs the repo's own CI (`ci.yml`) on the same commit.

## Copy to another Electron app

1. Copy `publik-updater.cjs`, `publik-update-verify.cjs`, `scripts/publik-update-feed.cjs`,
   `.github/workflows/update-feed.yml`, `.github/workflows/updater-proof.yml`,
   `.github/scripts/updater-proof.cjs`, `.github/scripts/updater-electron-crypto.cjs`,
   `test/fixtures/update-feed/`, the unit tests and this file.
2. `npm install electron-updater blakejs`.
3. In the electron-builder config: add the two `.cjs` files to `files`; set `publish` to
   `{ "provider": "generic", "url": "https://publikhq.com/api/updates/<slug>/" }`; ship a mac `zip` target.
4. In the main process, first thing in `app.whenReady()`:
   `if (startUpdates({ slug: '<slug>', appName: '<Name>' }).testHook) return;`
   If the app has its own menu, call `startUpdates({ ..., menu: false })` and add `updates.menuItem()`.
   If the app has no Dock icon, pass `show` and show the messages in the app's own window (as cue does).
5. Replace `cue` and the file names in `update-feed.yml`, `updater-proof.yml` and `updater-proof.cjs`
   (bundle ID check, installer names, the Windows uninstall entry name).
6. Add the repo secrets `PUBLIK_UPDATE_KEY` and `PUBLIK_UPDATE_KEY_PASSWORD`.
7. Add `PUBLIK_UPDATES: '0'` to the workflows that launch the app, and exclude `v*-updtest*` tags from
   any workflow that a `v*` tag starts.
8. Push, and check that the proof passes on all runners.
