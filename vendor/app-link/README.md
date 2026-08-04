# @publik/app-link

How a catalog app answers questions from Iris.

Logs tell you what an app *did*. This lets Iris ask what it is *doing*, and then
ask a follow-up. That difference is the whole point: the breaks tally and the
patch pipeline are only as good as their repro data, and a past-tense file is
the weakest input they have.

Zero dependencies, no build step. Vendor it, don't install it — see
[Vendoring](#vendoring).

## Wire it into an app

```js
const { AppLinkServer } = require("./vendor/app-link");

const link = new AppLinkServer({
  appId: "com.cue.overlay",        // the real bundle id, read off a build
  appSlug: "cue",                  // the publik catalog slug
  appVersion: app.getVersion(),
  stateProvider: () => ({
    listening: capture.isRunning(),
    provider: settings.provider,
  }),
  onConsentRequest: (request) => showConsentSheet(request), // returns a Promise<boolean>
});

await link.start();

// Wherever the app already logs, record too. Same event shape as
// docs/publik-sdk-convention.md, so one call can do both.
link.record({ level: "error", msg: String(error), frame: "CaptureService.grab" });
```

That is the whole requirement. The app now answers `describe`, `get_state`,
`get_recent_events`, `get_last_error` and `capture_diagnostics`.

Actions are opt-in and separately consented:

```js
link.action("stop_capture", {
  description: "Stop screen capture",
  handler: () => capture.stop(),
});
```

## What the user sees

Nothing, until something connects. Then `onConsentRequest` fires with:

```js
{ callerId: "com.publikhq.iris", callerName: "Iris", scope: "read",
  verification: "token", app: { id, name, version } }
```

Two scopes, asked separately, because they are not the same question: `read`
answers questions, `action` changes something. Both default to a prompt, and
anything other than an explicit `true` — a `false`, a throw, no handler at all —
is a no. Answers are remembered per caller in
`~/Library/Application Support/publik/consent/<app-id>.json` and revoked with
`link.consent.revoke(callerId)`, which is what an app's settings screen calls.

**Word the sheet from `verification`, not from `callerName`.** See below.

## What this actually authenticates

On Node the trust boundary is **the user account, not the calling app.**

Node cannot read a Unix socket peer's credentials without a native addon, so
there is no way from here to prove the process on the other end is Iris rather
than something else running as the same person. The per-session token does not
close that gap either — any process running as the user can read the instance
file it comes from.

So when `verification` is `"token"`, say *"a program identifying itself as
Iris"*, not *"Iris"*. An app that can verify its peer — the Swift apps, via the
peer audit token and `SecCodeCopySigningInformation` — passes a `verifyPeer`
hook, gets `"code-signature"`, and earns the stronger wording. Grants recorded
under the stronger check are **not** honoured for weaker callers, so gaining
verification later cannot retroactively hand old grants to an impostor.

What is enforced regardless:

- the run directory is `0700` and checked for ownership on every use, so nobody
  else on the machine reaches the socket;
- consent is required for reads, not just actions;
- 120 requests per 10s per connection, 8 connections, 1 MiB frames, and a
  120s idle timeout;
- known credential shapes are scrubbed out of recorded events.

On Windows there is one more gap worth naming: libuv gives no way to pass
`FILE_FLAG_FIRST_PIPE_INSTANCE`, so a Node server cannot claim its pipe name
exclusively. MSIX packaging or a small native addon fixes it; both are open
questions in `docs/iris-app-integration-plan.md`.

## Discovery

Each running app writes `~/Library/Application Support/publik/run/<app-id>.json`
(Windows: `%LOCALAPPDATA%\publik\run\`) with its socket path, PID, versions and
session token, and removes it on exit. One `readdir` gives a client discovery,
**liveness** and version negotiation at once. A file whose PID is dead is
dropped by the reader, so a crash leaves no ghost.

The socket normally sits beside it. If the path would exceed `sun_path`'s 104
bytes — a long username plus a long bundle id does it — the library falls back
to a private `0700` directory under the temp root. Nothing downstream notices,
because the instance file carries the real path. That is what the instance file
is *for*.

## Protocol

Newline-delimited JSON-RPC 2.0 — deliberately MCP's own stdio framing, which
the 2026-07-28 spec says custom byte-stream transports should reuse. First
message on a connection is `connect`; everything before it is refused with
`-32000`.

| Code | Meaning |
|---|---|
| `-32000` | not connected |
| `-32001` | scope not granted |
| `-32002` | bad token, or consent refused |
| `-32003` | rate limited |

MCP itself lives in Iris, not here. `docs/iris-app-integration-plan.md` has the
reasoning; the short version is that MCP's local transport assumes the client
*spawns* the server, which is the opposite of attaching to a running GUI app.

## Vendoring

There is no npm publish step. Copy `index.js` and `lib/` into the app repo —
`scripts/vendor-app-link.mts` in the publik repo does it and stamps the source
commit — and re-run it to update. Nine small repos are easier to audit with the
code in front of them than with a version range pointing at a registry.

## Tests

`npx vitest run packages/app-link` from the publik repo. They run a real socket
rather than a mock, because the parts most likely to break — path length,
directory modes, framing across chunk boundaries, cleanup on exit — are exactly
the parts a mock would paper over.
