#!/bin/bash
# cue release recipe for publik-loop. Installed as .loop/release.sh (human-merged; loop PRs may not touch it).
# Contract (publik-loop loop/effects/release.ts): exit 0 + "TAG=vX.Y.Z" (+ "ASSET=<name>" lines) on success;
# exit 78 with "NEEDS_SECRET=<what>" when a credential is missing, BEFORE anything is published.
#
# What a cue release is (same as v0.2.3/v0.2.4):
#   1. version bump on the default branch
#   2. macOS: built, Developer-ID signed and notarized ON THIS MAC (CI skips unsigned mac uploads since 828db44)
#   3. tag push -> .github/workflows/release.yml builds Windows + Linux and creates the GitHub release
#   4. the notarized mac zips are uploaded to that release
# Env in: LOOP_VERSION (optional, "0.2.5" or "v0.2.5"; default = patch bump), LOOP_TICKET, NOTARY_PROFILE
# (notarytool keychain profile, default "publik"), PUBLIK_DIR (publik checkout, default ~/publik).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=Blueturboguy07/cue
BRANCH=main
PROFILE="${NOTARY_PROFILE:-publik}"
PUBLIK_DIR="${PUBLIK_DIR:-$HOME/publik}"
log() { echo "==> $*" >&2; }

# ---- 0. preflight: nothing here has a side effect -------------------------------------------------
for t in gh node npm pnpm xcrun ditto security; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
gh auth status >/dev/null 2>&1 || { echo "NEEDS_SECRET=gh auth"; exit 78; }
# grep -q on a pipe under pipefail: grep exits at the first match, the writer dies of SIGPIPE (141) and the
# check fails on a good input. Capture first, then grep a here-string.
ids="$(security find-identity -v -p codesigning 2>/dev/null || true)"
grep -q "Developer ID Application" <<<"$ids" || { echo "NEEDS_SECRET=Developer ID Application identity in the keychain"; exit 78; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || { echo "NEEDS_SECRET=notarytool keychain profile $PROFILE"; exit 78; }
[ -f "$PUBLIK_DIR/scripts/mint-app-token.mts" ] || { echo "publik checkout not found at $PUBLIK_DIR (set PUBLIK_DIR)" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree is not clean" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH" 2>/dev/null || git rev-parse "$BRANCH")" ] || log "note: HEAD is not $BRANCH tip; releasing HEAD $(git rev-parse --short HEAD)"

# ---- 1. version ------------------------------------------------------------------------------------
cur=$(node -p "require('./package.json').version")
ver="${LOOP_VERSION:-}"; ver="${ver#v}"
[ -n "$ver" ] || ver=$(node -p "const [a,b,c]='$cur'.split('.').map(Number); [a,b,c+1].join('.')")
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version '$ver'" >&2; exit 1; }
tag="v$ver"
arm="cue-$ver-mac-arm64.zip"; x64="cue-$ver-mac-x64.zip"
RESUME=0
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  assets=$(gh release view "$tag" -R "$REPO" --json assets -q '.assets[].name' 2>/dev/null || true)
  if grep -qx "$arm" <<<"$assets" && grep -qx "$x64" <<<"$assets"; then
    log "$tag is already released with both mac zips"; echo "TAG=$tag"; sed 's/^/ASSET=/' <<<"$assets"; exit 0
  fi
  log "$tag exists on the remote without the mac zips; building only the macOS assets"
  RESUME=1
  git fetch -q origin "refs/tags/$tag:refs/tags/$tag" && git checkout -q --detach "$tag"
  [ "$(node -p "require('./package.json').version")" = "$ver" ] || { echo "tag $tag does not carry version $ver" >&2; exit 1; }
fi
if [ "$RESUME" = 0 ] && [ "$ver" != "$cur" ]; then
  npm version "$ver" --no-git-tag-version >/dev/null
  git add package.json package-lock.json
  git commit -q -m "release: cue v$ver" -m "Loop-Ticket: ${LOOP_TICKET:-manual}"
  log "bumped $cur -> $ver (local commit, not pushed yet)"
fi

# ---- 2. the app token for this build (minted like CI's PUBLIK_APP_TOKEN; one token per release) -----
T=$(cd "$PUBLIK_DIR" && pnpm exec tsx scripts/mint-app-token.mts cue --add --label "loop-${LOOP_TICKET:-manual}-$ver" 2>/dev/null || true)
[ ${#T} -gt 30 ] || { echo "NEEDS_SECRET=publik app token mint (SUPABASE_SERVICE_ROLE_KEY in $PUBLIK_DIR/.env.local)"; exit 78; }
restore_build_json() { git checkout -q -- src/publik-build.json 2>/dev/null || true; }
trap restore_build_json EXIT
T="$T" node -e '
  const fs = require("fs"); const p = "src/publik-build.json";
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.appToken = process.env.T;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");'
unset T
node -e 'const c = require("./src/publik-build.json"); if (!c.appToken) process.exit(1);' || { echo "token embed failed" >&2; exit 1; }
log "app token embedded (value not shown)"

# ---- 3. build + sign on this Mac (electron-builder.cjs: MAC_SIGN=1 -> Developer ID + hardened runtime) ----
log "npm ci"; npm ci --silent >/dev/null 2>&1 || npm ci >&2
rm -rf dist
log "building signed mac zips"
MAC_SIGN=1 npm run dist:mac 2>&1 | grep -vE 'pat_' | tail -20 >&2
restore_build_json
[ -f "dist/$arm" ] && [ -f "dist/$x64" ] || { echo "expected dist/$arm and dist/$x64" >&2; ls dist >&2 || true; exit 1; }

# ---- 4. notarize each zip, staple the app, re-zip. Still nothing published. ---------------------------
for arch in arm64 x64; do
  zip="dist/cue-$ver-mac-$arch.zip"
  appdir="dist/mac-$arch/cue.app"; [ -d "$appdir" ] || appdir="dist/mac/cue.app"
  [ -d "$appdir" ] || { echo "no .app for $arch under dist/" >&2; exit 1; }
  sig="$(codesign -dvv "$appdir" 2>&1 || true)"
  grep -q "^Authority=Developer ID Application" <<<"$sig" || { echo "$appdir is not Developer ID signed" >&2; exit 1; }
  log "notarizing $zip"
  out=$(xcrun notarytool submit "$zip" --keychain-profile "$PROFILE" --wait 2>&1 | tail -6)
  echo "$out" >&2
  grep -q "status: Accepted" <<<"$out" || { echo "notarization not accepted for $zip" >&2; exit 1; }
  xcrun stapler staple "$appdir" >&2
  xcrun stapler validate "$appdir" >&2
  rm -f "$zip"; ditto -c -k --keepParent "$appdir" "$zip"
  log "stapled and re-zipped $zip"
done

# ---- 5. publish: push the bump + tag; CI builds Windows and Linux and creates the release ------------
if [ "$RESUME" = 0 ]; then
  log "pushing $BRANCH and $tag"
  git push -q origin "HEAD:$BRANCH"
  git tag -a "$tag" -m "cue $tag"
  git push -q origin "refs/tags/$tag"
fi
log "waiting for release.yml on $tag"
run_state=""
for _ in $(seq 1 75); do
  run_state=$(gh run list -R "$REPO" --workflow release.yml --branch "$tag" -L 1 --json status,conclusion -q '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null || true)
  case "$run_state" in
    "completed success") break ;;
    completed*) echo "release.yml on $tag ended: $run_state" >&2; exit 1 ;;
  esac
  sleep 20
done
[ "$run_state" = "completed success" ] || { echo "release.yml on $tag did not finish in time (last: ${run_state:-no run yet})" >&2; exit 1; }
gh release view "$tag" -R "$REPO" >/dev/null 2>&1 || { echo "CI finished but release $tag does not exist" >&2; exit 1; }

# ---- 6. upload the notarized mac zips, verify, report ------------------------------------------------
log "uploading mac zips to $tag"
gh release upload "$tag" "dist/$arm" "dist/$x64" -R "$REPO" --clobber >&2
assets=$(gh release view "$tag" -R "$REPO" --json assets -q '.assets[].name')
for want in "$arm" "$x64" "cue-win-x64.exe"; do grep -qx "$want" <<<"$assets" || { echo "release $tag is missing $want" >&2; exit 1; }; done
echo "TAG=$tag"
sed 's/^/ASSET=/' <<<"$assets"
