#!/bin/bash
# publik-release.sh <version> [--notes-file <file>] [--summary <text>]
#
# Cuts a cue release in ONE command, on the release Mac (docs/updates.md › "Cut a release"):
#   1. checks       clean tree on main, in step with origin; the version is higher than the last release;
#                   the tag is free (a DRAFT of this script for the same commit is resumed); the bump is in
#                   package.json and package-lock.json (made, committed and pushed here if it is missing)
#   2. CI build     publik-build.yml for this commit (an earlier green run of the same commit is reused):
#                   the Windows installer, the two Linux AppImages and the two macOS apps, UNSIGNED
#   3. draft        a DRAFT release vX.Y.Z for this commit
#   4. macOS        per architecture: sign on this Mac with the keychain identity (inner code first,
#                   hardened runtime, build-resources/entitlements.mac.plist), notarize
#                   (notarytool, keychain profile "publik"), staple, check, zip (Squirrel.Mac installs from
#                   the zip). cue ships zips only, no dmg, as every earlier release.
#   5. files        uploads every installer (the asset names of the last release) and SHA256SUMS.txt
#   6. feed         latest.yml, latest-mac.yml and their .sig with absolute GitHub URLs, signed with the update
#                   key from the keychain (service publik-update-key) by scripts/publik-update-feed.cjs
#   7. verify       downloads everything back from the draft: feed signatures with the app's public key,
#                   sha512/size of every feed file, SHA256SUMS, versions (Info.plist, exe ProductVersion),
#                   codesign, Developer ID, designated requirement, stapler, Gatekeeper, the publik app token
#                   (same as the last release), repo CI green on this commit
#   8. publish      only when every check passed: public, "latest"; then the public URLs must answer 200
#
# Re-run the same command after a failure: it resumes the draft (files already on it are kept; the feed is
# made again). It never starts the app, never prints a secret, and stops before publishing on any failed check.
# Environment (all optional):
#   PUBLIK_RELEASE_WORK         work folder (default: $TMPDIR/publik-release-cue-vX.Y.Z); deleted at the end
#   PUBLIK_RELEASE_MIN_FREE_MB  free disk needed before each download (default 1500)
#   PUBLIK_RELEASE_TRAILER      a trailer line for the version-bump commit
set -euo pipefail
set +x
umask 022

APP=cue
REPO=Blueturboguy07/cue
BRANCH=main
BUNDLE_ID=com.cue.overlay
TEAM=R5R3ZS54LV
SIGN_ID="Developer ID Application: Mann Bellani ($TEAM)"
NOTARY_PROFILE=publik
KEY_SERVICE=publik-update-key
KEY_ID=F5E0515C77912BD0
ENT=build-resources/entitlements.mac.plist
EXPECTED_DR="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = $TEAM"
ARCHES="x64 arm64"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
ok() { printf 'OK    %s\n' "$*"; }
FAILS=0
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

VERSION="${1:-}"
shift || true
NOTES_FILE=""
SUMMARY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file) NOTES_FILE="$2"; shift 2 ;;
    --summary) SUMMARY="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/publik-release.sh X.Y.Z [--notes-file F] [--summary TEXT]"
TAG="v$VERSION"
case "$TAG" in *arm64*) die "a tag must not contain arm64 (docs/updates.md)" ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WORK="${PUBLIK_RELEASE_WORK:-${TMPDIR:-/tmp}/publik-release-$APP-$TAG}"
MIN_FREE_MB="${PUBLIK_RELEASE_MIN_FREE_MB:-1500}"
mkdir -p "$WORK/tmp"
WORK="$(cd "$WORK" && pwd)"
export TMPDIR="$WORK/tmp" # gh and node keep their temporary files here, and they go with the work folder
LOCK="$WORK/lock"
mkdir "$LOCK" 2>/dev/null || die "another run holds $LOCK (remove it if no run is active)"
cleanup() { rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT

WIN_EXE="$APP-win-x64.exe"
mac_zip() { echo "$APP-$VERSION-mac-$1.zip"; }
LINUX_FILES="$APP-$VERSION-linux-arm64.AppImage $APP-$VERSION-linux-x86_64.AppImage"
INSTALLERS="$(mac_zip x64) $(mac_zip arm64) $WIN_EXE $LINUX_FILES"
FEED_FILES="latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig"
ALL_ASSETS="$INSTALLERS SHA256SUMS.txt $FEED_FILES"

free_mb() { df -m "$WORK" | awk 'NR==2 { print $4 }'; }
need_disk() {
  local f; f="$(free_mb)"
  [ "$f" -ge "$MIN_FREE_MB" ] || die "only $f MB free on the disk of $WORK; $MIN_FREE_MB MB needed before $1"
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }

# ---------------------------------------------------------------- 0. tools
step "0. tools"
for t in gh git node npx codesign xcrun ditto security shasum openssl python3 lipo spctl curl file; do
  command -v "$t" >/dev/null || die "$t is missing"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
IDS="$(security find-identity -v -p codesigning)"
grep -qF "\"$SIGN_ID\"" <<<"$IDS" || die "the keychain has no \"$SIGN_ID\""
security find-generic-password -s "$KEY_SERVICE" -a mann-private >/dev/null 2>&1 || die "the keychain has no $KEY_SERVICE/mann-private"
security find-generic-password -s "$KEY_SERVICE" -a mann-password >/dev/null 2>&1 || die "the keychain has no $KEY_SERVICE/mann-password"
test -f "$ENT" || die "$ENT is missing"
ok "tools, signing identity, update key and notary profile name present; work folder $WORK ($(free_mb) MB free)"

# ---------------------------------------------------------------- 1. checks
step "1. checks"
git fetch --quiet origin "$BRANCH" --tags
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "not on $BRANCH"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
LAST_TAG="$(gh release view -R "$REPO" --json tagName --jq .tagName)"
LAST_VERSION="${LAST_TAG#v}"
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]; }
newer "$VERSION" "$LAST_VERSION" || die "$VERSION is not higher than the last release $LAST_VERSION"
ok "last release $LAST_TAG; new version $VERSION"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "the tag $TAG exists on origin: $TAG is taken (published already?)"
fi
REL_JSON="$(gh release view "$TAG" -R "$REPO" --json isDraft,targetCommitish,assets 2>/dev/null || true)"
if [ -n "$REL_JSON" ] && [ "$(node -p 'JSON.parse(process.argv[1]).isDraft' "$REL_JSON")" != true ]; then
  die "a published release $TAG exists"
fi

bump_files_ok() {
  node -e '
    const v = process.argv[1]; const p = require("./package.json"); const l = require("./package-lock.json");
    const got = { "package.json": p.version, "package-lock.json": l.version, "package-lock.json packages[\"\"]": l.packages[""].version };
    const badOnes = Object.entries(got).filter(([, x]) => x !== v);
    if (badOnes.length) { console.log(JSON.stringify(got)); process.exit(1); }
  ' "$VERSION"
}
if [ "$(node -p 'require("./package.json").version')" != "$VERSION" ]; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD is not origin/$BRANCH: push or pull first"
  say "bumping the version to $VERSION in package.json and package-lock.json (the files the last bump touched)"
  node -e '
    const fs = require("fs"); const v = process.argv[1];
    const p = JSON.parse(fs.readFileSync("package.json", "utf8")); p.version = v;
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); l.version = v; l.packages[""].version = v;
    fs.writeFileSync("package-lock.json", JSON.stringify(l, null, 2) + "\n");
  ' "$VERSION"
  [ "$(git diff --numstat | wc -l | tr -d ' ')" = 2 ] || die "the bump changed more than package.json and package-lock.json"
  MSG="release: $APP $TAG"
  [ -n "$SUMMARY" ] && MSG="$MSG"$'\n\n'"$SUMMARY"
  [ -n "${PUBLIK_RELEASE_TRAILER:-}" ] && MSG="$MSG"$'\n\n'"$PUBLIK_RELEASE_TRAILER"
  git add package.json package-lock.json
  git commit --quiet -m "$MSG"
  git push --quiet origin "$BRANCH"
  git fetch --quiet origin "$BRANCH"
fi
bump_files_ok || die "the version is not $VERSION in every bump file"
SHA="$(git rev-parse HEAD)"
[ "$SHA" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD $SHA is not pushed to origin/$BRANCH"
ok "version $VERSION in package.json and package-lock.json; commit $SHA is origin/$BRANCH"

# ---------------------------------------------------------------- 2. CI build
step "2. CI build (publik-build.yml) for $SHA"
find_run() { # the newest publik-build run of this commit: "<id> <status> <conclusion>"
  gh run list -R "$REPO" -w publik-build.yml -b "$BRANCH" -L 30 --json databaseId,headSha,status,conclusion \
    --jq "[.[] | select(.headSha == \"$SHA\")] | sort_by(.databaseId) | reverse | .[0] | select(. != null) | \"\(.databaseId) \(.status) \(.conclusion)\""
}
RUN_LINE="$(find_run)"
if [ -z "$RUN_LINE" ] || { [ "$(cut -d' ' -f2 <<<"$RUN_LINE")" = completed ] && [ "$(cut -d' ' -f3 <<<"$RUN_LINE")" != success ]; }; then
  gh workflow run publik-build.yml -R "$REPO" --ref "$BRANCH"
  say "started publik-build.yml; waiting for the run to appear"
  OLD="$(cut -d' ' -f1 <<<"$RUN_LINE")"
  for _ in $(seq 1 60); do
    sleep 10
    RUN_LINE="$(find_run)"
    [ -n "$RUN_LINE" ] && [ "$(cut -d' ' -f1 <<<"$RUN_LINE")" != "$OLD" ] && break
  done
fi
[ -n "$RUN_LINE" ] || die "no publik-build run for $SHA"
RUN="$(cut -d' ' -f1 <<<"$RUN_LINE")"
say "build run: https://github.com/$REPO/actions/runs/$RUN"
while :; do
  read -r STATUS CONCLUSION < <(gh run view "$RUN" -R "$REPO" --json status,conclusion --jq '"\(.status) \(.conclusion)"')
  [ "$STATUS" = completed ] && break
  sleep 30
done
[ "$CONCLUSION" = success ] || die "build run $RUN ended: $CONCLUSION"
[ "$(gh run view "$RUN" -R "$REPO" --json headSha --jq .headSha)" = "$SHA" ] || die "build run $RUN is not for $SHA"
ok "build run $RUN: success (its jobs checked the publik app token in the packed apps and ran the publik self-test)"

# ---------------------------------------------------------------- 3. draft
step "3. draft release $TAG"
if [ -z "$REL_JSON" ]; then
  NOTES="$WORK/notes.md"
  if [ -n "$NOTES_FILE" ]; then cp "$NOTES_FILE" "$NOTES"; else
    { echo "## cue $VERSION"; echo; echo "Changes since $LAST_TAG:"; echo; git log --format='- %s' "$LAST_TAG..$SHA"; echo
      echo "cue updates itself on macOS and Windows (docs/updates.md). Linux: download the AppImage from this page."; } > "$NOTES"
  fi
  gh release create "$TAG" -R "$REPO" --draft --target "$SHA" --title "$APP $VERSION" --notes-file "$NOTES" >/dev/null
  ok "draft $TAG created for $SHA"
else
  TARGET="$(node -p 'JSON.parse(process.argv[1]).targetCommitish' "$REL_JSON")"
  [ "$TARGET" = "$SHA" ] || die "the draft $TAG targets $TARGET, not $SHA"
  ok "resuming the draft $TAG ($SHA)"
fi
assets() { gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name'; }
has() { local a; a="$(assets)"; grep -qxF "$1" <<<"$a"; }
upload() { gh release upload "$TAG" -R "$REPO" --clobber "$@" >/dev/null; }
mkdir -p "$WORK/sums"
record_sums() { # sha256 for SHA256SUMS.txt, sha512 for the feed check, of a local file
  shasum -a 256 "$1" | cut -d' ' -f1 > "$WORK/sums/$(basename "$1").sha256"
  openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n' > "$WORK/sums/$(basename "$1").sha512"
}
CHANGED=0

# The publik app token of the last release, as a hash (never the token): read with HTTP range requests from
# the last release's arm64 zip, without downloading it.
token_hash_remote() {
  python3 -I - "$1" <<'PY'
import hashlib, json, sys, urllib.request, zipfile
class R:
    def __init__(s, url):
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            s.url, s.size = r.geturl(), int(r.headers["Content-Length"])
        s.pos = 0
    def seekable(s): return True
    def tell(s): return s.pos
    def seek(s, o, w=0):
        s.pos = o if w == 0 else s.pos + o if w == 1 else s.size + o
        return s.pos
    def read(s, n=-1):
        if n is None or n < 0: n = s.size - s.pos
        if n == 0 or s.pos >= s.size: return b""
        end = min(s.pos + n, s.size) - 1
        with urllib.request.urlopen(urllib.request.Request(s.url, headers={"Range": f"bytes={s.pos}-{end}"})) as r: d = r.read()
        s.pos += len(d)
        return d
z = zipfile.ZipFile(R(sys.argv[1]))
m = [n for n in z.namelist() if n.endswith("Contents/Resources/app/src/publik-build.json")]
t = json.loads(z.read(m[0])).get("appToken") or ""
print(("pat_" if t.startswith("pat_") else "NOT-pat_") + " sha256:" + hashlib.sha256(t.encode()).hexdigest()[:16] + " length:" + str(len(t)))
PY
}
token_hash_local() {
  node -e '
    const t = require(process.argv[1]).appToken || "";
    console.log((t.startsWith("pat_") ? "pat_" : "NOT-pat_") + " sha256:" + require("crypto").createHash("sha256").update(t).digest("hex").slice(0, 16) + " length:" + t.length);
  ' "$1/Contents/Resources/app/src/publik-build.json"
}
LAST_TOKEN="$(token_hash_remote "https://github.com/$REPO/releases/download/$LAST_TAG/$APP-$LAST_VERSION-mac-arm64.zip")"
say "publik app token of $LAST_TAG: $LAST_TOKEN"
case "$LAST_TOKEN" in pat_*) ;; *) die "cannot read the app token of $LAST_TAG" ;; esac

check_mac_app() { # <app> <arch>: every check of a final macOS app; returns 1 on a failure
  local app="$1" arch="$2" lipo_want fails=0 v dv dr gk tok
  lipo_want="$arch"; [ "$arch" = x64 ] && lipo_want=x86_64
  v="$(plist "$app" CFBundleShortVersionString)"
  [ "$v" = "$VERSION" ] && ok "$arch: Info.plist CFBundleShortVersionString $v" || { bad "$arch: Info.plist version $v, not $VERSION"; fails=1; }
  [ "$(plist "$app" CFBundleIdentifier)" = "$BUNDLE_ID" ] && ok "$arch: bundle ID $BUNDLE_ID" || { bad "$arch: bundle ID"; fails=1; }
  [ "$(lipo -archs "$app/Contents/MacOS/$APP")" = "$lipo_want" ] && ok "$arch: lipo $lipo_want" || { bad "$arch: lipo $(lipo -archs "$app/Contents/MacOS/$APP")"; fails=1; }
  codesign --verify --deep --strict "$app" 2>/dev/null && ok "$arch: codesign --verify --deep --strict" || { bad "$arch: codesign --verify"; fails=1; }
  dv="$(codesign -dvv "$app" 2>&1)"
  grep -qxF "Authority=$SIGN_ID" <<<"$dv" && grep -qxF "TeamIdentifier=$TEAM" <<<"$dv" && grep -q 'flags=.*runtime' <<<"$dv" \
    && ok "$arch: signed by $SIGN_ID, hardened runtime" || { bad "$arch: signer/runtime: $(grep -E '^(Authority|TeamIdentifier|CodeDirectory)' <<<"$dv" | tr '\n' ' ')"; fails=1; }
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
  [ "$dr" = "$EXPECTED_DR" ] && ok "$arch: designated requirement as every release (TCC grants keep)" || { bad "$arch: designated requirement $dr"; fails=1; }
  xcrun stapler validate "$app" >/dev/null 2>&1 && ok "$arch: stapler validate" || { bad "$arch: no stapled ticket"; fails=1; }
  gk="$(spctl -a -vvv -t exec "$app" 2>&1)"
  grep -q accepted <<<"$gk" && grep -qx 'source=Notarized Developer ID' <<<"$gk" && ok "$arch: spctl accepted, source=Notarized Developer ID" || { bad "$arch: spctl: $(tr '\n' ' ' <<<"$gk")"; fails=1; }
  tok="$(token_hash_local "$app")"
  [ "$tok" = "$LAST_TOKEN" ] && ok "$arch: publik app token present, same as $LAST_TAG ($tok)" || { bad "$arch: app token $tok, $LAST_TAG has $LAST_TOKEN"; fails=1; }
  for f in publik-updater.cjs publik-update-verify.cjs node_modules/electron-updater/package.json src/publik-gate.js; do
    test -f "$app/Contents/Resources/app/$f" || { bad "$arch: $f missing in the app"; fails=1; }
  done
  return $fails
}

# ---------------------------------------------------------------- 4. macOS: sign, notarize, staple, zip
sign_app() { # <app>: inner code first (loose Mach-O files, then nested bundles, deepest first), then the app
  local app="$1" f b n=0
  sig() {
    local out
    out="$(codesign --force --sign "$SIGN_ID" --options runtime --timestamp --entitlements "$ENT" "$1" 2>&1)" || die "codesign failed on $1: $out"
  }
  while IFS= read -r f; do
    [ -L "$f" ] && continue
    case "$(file -b "$f")" in *Mach-O*) ;; *) continue ;; esac
    case "$f" in *.app/Contents/MacOS/*) continue ;; esac
    case "$(dirname "$f")" in *.framework/Versions/[A-Z]) continue ;; esac
    sig "$f"; n=$((n + 1))
  done < <(find "$app/Contents" -type f | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
  while IFS= read -r b; do sig "$b"; done < <(find "$app/Contents" -type d \( -name '*.framework' -o -name '*.app' \) | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
  sig "$app"
  say "signed $n loose Mach-O files, the nested bundles and the app"
}
for ARCH in $ARCHES; do
  ZIP="$(mac_zip "$ARCH")"
  if has "$ZIP"; then ok "$ZIP is on the draft already"; continue; fi
  step "4. macOS $ARCH: $ZIP"
  need_disk "the $ARCH app"
  D="$WORK/mac-$ARCH"; rm -rf "$D"; mkdir -p "$D"
  gh run download "$RUN" -R "$REPO" -n "mac-$ARCH-unsigned-app" -D "$D/artifact"
  ditto -x -k "$D/artifact/$APP-$VERSION-mac-$ARCH-unsigned-app.zip" "$D/x"
  rm -rf "$D/artifact"
  A="$D/x/$APP.app"
  test -d "$A" || die "no $APP.app in the $ARCH artifact"
  [ "$(plist "$A" CFBundleShortVersionString)" = "$VERSION" ] || die "$ARCH app from CI is $(plist "$A" CFBundleShortVersionString)"
  sign_app "$A"
  codesign --verify --deep --strict "$A" || die "$ARCH: codesign --verify failed after signing"
  ditto -c -k --keepParent "$A" "$D/notarize.zip"
  say "notarizing $ARCH (xcrun notarytool submit --keychain-profile $NOTARY_PROFILE --wait)"
  NJSON="$(xcrun notarytool submit "$D/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)"
  rm -f "$D/notarize.zip"
  NSTATUS="$(node -p 'JSON.parse(process.argv[1]).status' "$NJSON")"
  NID="$(node -p 'JSON.parse(process.argv[1]).id' "$NJSON")"
  if [ "$NSTATUS" != Accepted ]; then
    xcrun notarytool log "$NID" --keychain-profile "$NOTARY_PROFILE" || true
    die "$ARCH: notarization $NID: $NSTATUS"
  fi
  ok "$ARCH: notarization $NID Accepted"
  xcrun stapler staple "$A" >/dev/null || die "$ARCH: stapling failed"
  check_mac_app "$A" "$ARCH" || die "$ARCH: the signed app failed a check (above)"
  ditto -c -k --sequesterRsrc --keepParent "$A" "$D/$ZIP"
  rm -rf "$D/x"
  record_sums "$D/$ZIP"
  upload "$D/$ZIP"
  rm -rf "$D"
  CHANGED=1
  ok "$ZIP uploaded"
done

# ---------------------------------------------------------------- 5. Windows and Linux files, SHA256SUMS
if ! has "$WIN_EXE"; then
  step "5. Windows: $WIN_EXE"
  need_disk "the Windows installer"
  D="$WORK/win"; rm -rf "$D"
  gh run download "$RUN" -R "$REPO" -n windows-installer -D "$D"
  PV="$(node -e 'console.log(require("./scripts/publik-update-feed.cjs").exeProductVersions(require("fs").readFileSync(process.argv[1])).join(","))' "$D/$WIN_EXE")"
  case ",$PV," in *",$VERSION,"*) ok "$WIN_EXE ProductVersion $PV" ;; *) die "$WIN_EXE ProductVersion is $PV, not $VERSION" ;; esac
  record_sums "$D/$WIN_EXE"
  upload "$D/$WIN_EXE"
  rm -rf "$D"
  CHANGED=1
fi
for F in $LINUX_FILES; do
  has "$F" && continue
  step "5. Linux: $F"
  need_disk "the Linux AppImages"
  D="$WORK/linux"; rm -rf "$D"
  gh run download "$RUN" -R "$REPO" -n linux-appimages -D "$D"
  for G in $LINUX_FILES; do
    test -f "$D/$G" || die "$G is not in the linux-appimages artifact"
    has "$G" && continue
    record_sums "$D/$G"
    upload "$D/$G"
    ok "$G uploaded"
  done
  rm -rf "$D"
  CHANGED=1
  break
done
stream_sha() { # <asset> <algorithm 256|512>: the hash of the asset on the draft, streamed (no file on disk)
  if [ "$2" = 256 ]; then gh release download "$TAG" -R "$REPO" -p "$1" -O - | shasum -a 256 | cut -d' ' -f1
  else gh release download "$TAG" -R "$REPO" -p "$1" -O - | openssl dgst -sha512 -binary | base64 | tr -d '\n'; fi
}
if [ "$CHANGED" = 1 ] || ! has SHA256SUMS.txt; then
  step "5. SHA256SUMS.txt"
  : > "$WORK/SHA256SUMS.txt"
  for F in $(printf '%s\n' $INSTALLERS | LC_ALL=C sort); do
    if [ -f "$WORK/sums/$F.sha256" ]; then S="$(cat "$WORK/sums/$F.sha256")"; else S="$(stream_sha "$F" 256)"; fi
    printf '%s  %s\n' "$S" "$F" >> "$WORK/SHA256SUMS.txt"
  done
  cat "$WORK/SHA256SUMS.txt"
  upload "$WORK/SHA256SUMS.txt"
  CHANGED=1
fi

# ---------------------------------------------------------------- 6. the signed feed
FEED_MISSING=0
for F in $FEED_FILES; do has "$F" || FEED_MISSING=1; done
if [ "$CHANGED" = 1 ] || [ "$FEED_MISSING" = 1 ]; then
  step "6. feed: latest.yml, latest-mac.yml and their signatures (update key from the keychain)"
  need_disk "the feed (it reads the Windows installer and the two mac zips)"
  (
    PUBLIK_UPDATE_KEY="$(security find-generic-password -s "$KEY_SERVICE" -a mann-private -w)"
    PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s "$KEY_SERVICE" -a mann-password -w)"
    export PUBLIK_UPDATE_KEY PUBLIK_UPDATE_KEY_PASSWORD
    node scripts/publik-update-feed.cjs release --tag "$TAG" --app "$APP" --repo "$REPO" --force
  )
  rm -rf "$WORK/tmp"/publik-feed-*
fi

# ---------------------------------------------------------------- 7. verify the draft
step "7. verify everything on the draft"
REL="$(gh release view "$TAG" -R "$REPO" --json isDraft,targetCommitish,assets,tagName)"
[ "$(node -p 'JSON.parse(process.argv[1]).isDraft' "$REL")" = true ] && ok "$TAG is a draft" || bad "$TAG is not a draft"
[ "$(node -p 'JSON.parse(process.argv[1]).targetCommitish' "$REL")" = "$SHA" ] && ok "target $SHA" || bad "target is not $SHA"
GOT="$(node -p 'JSON.parse(process.argv[1]).assets.map((a) => a.name).sort().join(" ")' "$REL")"
WANT="$(printf '%s\n' $ALL_ASSETS | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
[ "$(tr ' ' '\n' <<<"$GOT" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" = "$WANT" ] && ok "assets: $WANT" || bad "assets: $GOT (want $WANT)"
V="$WORK/verify"; rm -rf "$V"; mkdir -p "$V"
gh release download "$TAG" -R "$REPO" -D "$V" -p latest.yml -p latest.yml.sig -p latest-mac.yml -p latest-mac.yml.sig -p SHA256SUMS.txt
VOUT="$(node scripts/publik-update-feed.cjs verify "$V/latest.yml" "$V/latest-mac.yml" 2>&1)" && ok "feed signatures: $(tr '\n' ' ' <<<"$VOUT")" || bad "feed signature: $VOUT"
grep -c "key $KEY_ID" <<<"$VOUT" | grep -qx 2 || bad "the feeds are not both signed with key $KEY_ID"
BASE="https://github.com/$REPO/releases/download/$TAG"
feed_check() { # <feed> <expected file names...>: header, app, absolute URLs
  local feed="$1"; shift
  grep -qx "version: '$VERSION'" "$V/$feed" && grep -qx "publikApp: '$APP'" "$V/$feed" && ok "$feed: version $VERSION, publikApp $APP" || bad "$feed: header"
  local urls want
  urls="$(sed -n "s/^  - url: '\(.*\)'$/\1/p" "$V/$feed" | tr '\n' ' ' | sed 's/ $//')"
  want="$(for n in "$@"; do printf '%s/%s ' "$BASE" "$n"; done | sed 's/ $//')"
  [ "$urls" = "$want" ] && ok "$feed: absolute URLs $urls" || bad "$feed: URLs $urls (want $want)"
}
feed_check latest.yml "$WIN_EXE"
feed_check latest-mac.yml "$(mac_zip x64)" "$(mac_zip arm64)"
feed_entry() { # <feed> <file name> → "sha512 size" of the entry with that URL
  node -e '
    const [file, url] = process.argv.slice(1);
    const text = require("fs").readFileSync(file, "utf8");
    const re = /^  - url: '"'"'([^'"'"'\n]+)'"'"'\n    sha512: '"'"'([^'"'"'\n]+)'"'"'\n    size: (\d+)/gm;
    for (const m of text.matchAll(re)) if (m[1] === url) console.log(`${m[2]} ${m[3]}`);
  ' "$V/$1" "$BASE/$2"
}
for F in $INSTALLERS; do
  need_disk "the check of $F"
  gh release download "$TAG" -R "$REPO" -p "$F" -D "$V"
  S256="$(shasum -a 256 "$V/$F" | cut -d' ' -f1)"
  S512="$(openssl dgst -sha512 -binary "$V/$F" | base64 | tr -d '\n')"
  SIZE="$(stat -f %z "$V/$F")"
  grep -qxF "$S256  $F" "$V/SHA256SUMS.txt" && ok "$F: sha256 = SHA256SUMS.txt" || bad "$F: sha256 not in SHA256SUMS.txt"
  if [ -f "$WORK/sums/$F.sha512" ]; then [ "$(cat "$WORK/sums/$F.sha512")" = "$S512" ] && ok "$F: downloaded = the file made here" || bad "$F: downloaded bytes differ from the file made here"; fi
  case "$F" in
    *.exe|*-mac-*.zip)
      FEED=latest.yml; case "$F" in *-mac-*) FEED=latest-mac.yml ;; esac
      E="$(feed_entry "$FEED" "$F")"
      [ "$E" = "$S512 $SIZE" ] && ok "$F: sha512 and size = $FEED" || bad "$F: $FEED has \"$E\", the file is \"${S512:0:20}… $SIZE\"" ;;
  esac
  case "$F" in
    *.exe)
      PV="$(node -e 'console.log(require("./scripts/publik-update-feed.cjs").exeProductVersions(require("fs").readFileSync(process.argv[1])).join(","))' "$V/$F")"
      case ",$PV," in *",$VERSION,"*) ok "$F: ProductVersion $VERSION (= feed version)" ;; *) bad "$F: ProductVersion $PV" ;; esac ;;
    *-mac-*.zip)
      ARCH="${F##*-mac-}"; ARCH="${ARCH%.zip}"
      X="$V/x-$ARCH"; mkdir -p "$X"
      xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$V/$F"
      ditto -x -k "$V/$F" "$X"
      check_mac_app "$X/$APP.app" "$ARCH" || true # each failure is counted in FAILS
      rm -rf "$X" ;;
    *.AppImage)
      case "$F" in *"-$VERSION-"*) ok "$F: name carries $VERSION" ;; *) bad "$F: name" ;; esac ;;
  esac
  rm -f "$V/$F"
done
say "repo CI (ci.yml) on $SHA:"
CI=""
for _ in $(seq 1 60); do
  CI="$(gh run list -R "$REPO" -w ci.yml -c "$SHA" -L 1 --json status,conclusion,databaseId --jq '.[0] | "\(.status) \(.conclusion) \(.databaseId)"' 2>/dev/null || true)"
  case "$CI" in completed*|"") break ;; esac
  sleep 30
done
case "$CI" in "completed success "*) ok "CI run ${CI##* } green on $SHA" ;; *) bad "CI on $SHA: ${CI:-no run}" ;; esac
if [ "$FAILS" -gt 0 ]; then
  say ""
  die "$FAILS check(s) failed: $TAG stays a DRAFT. Fix the cause and run the same command again (to make a file again, delete it from the draft first: gh release delete-asset $TAG <file> -R $REPO)."
fi
ok "every check passed"

# ---------------------------------------------------------------- 8. publish
step "8. publish $TAG"
gh release edit "$TAG" -R "$REPO" --draft=false --latest >/dev/null
sleep 5
[ "$(gh release view "$TAG" -R "$REPO" --json isDraft --jq .isDraft)" = false ] || die "$TAG is still a draft"
git fetch --quiet origin --tags
[ "$(git rev-list -n 1 "$TAG")" = "$SHA" ] && ok "tag $TAG = $SHA" || bad "tag $TAG is not at $SHA"
for F in $ALL_ASSETS; do
  CODE="$(curl -s -o /dev/null -L -r 0-0 -w '%{http_code}' "$BASE/$F")"
  case "$CODE" in 200|206) ok "public $BASE/$F ($CODE)" ;; *) bad "public $BASE/$F answers $CODE" ;; esac
done
for F in latest-mac.yml latest.yml; do
  say "publik serves $F now: $(curl -s "https://publikhq.com/api/updates/$APP/$F" | sed -n "s/^version: //p" | head -1) (publik takes in new releases at 10:00 UTC)"
done
# Publishing created the tag, and the tag starts release.yml: its guard must see the files and build nothing.
RR=""
for _ in $(seq 1 30); do
  RR="$(gh run list -R "$REPO" -w release.yml -L 10 --json databaseId,headBranch,status --jq "[.[] | select(.headBranch == \"$TAG\")][0] | select(. != null) | \"\(.databaseId) \(.status)\"" 2>/dev/null || true)"
  case "$RR" in *" completed") break ;; esac
  sleep 10
done
if [ -n "$RR" ]; then
  JOBS="$(gh run view "${RR%% *}" -R "$REPO" --json jobs --jq '.jobs[] | "\(.name)=\(.conclusion)"' | tr '\n' ' ')"
  case "$JOBS" in *"Build on"*"=success"*) bad "release.yml run ${RR%% *} built over the release: $JOBS" ;; *) ok "release.yml run ${RR%% *}: the guard kept the files ($JOBS)" ;; esac
else
  say "note: no release.yml run for $TAG seen within 5 minutes"
fi
[ "$FAILS" -eq 0 ] || die "$FAILS check(s) after publishing failed (above)"
cd "$ROOT"
rm -rf "$WORK"
ok "released: https://github.com/$REPO/releases/tag/$TAG"
