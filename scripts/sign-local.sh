#!/bin/bash
# Sign a local build with a stable self-signed identity so macOS keeps the
# Screen Recording / Microphone grants across rebuilds (ad-hoc signing gets a
# new identity every build, which is what makes macOS ask again).
# Local use only: a self-signed app is not distributable. Releases use MAC_SIGN=1.
set -euo pipefail
NAME="cue local signing"
APP="${1:-dist/mac-arm64/cue.app}"
# A dedicated keychain with a password we control, so macOS never asks for the login password.
KC="$HOME/Library/Keychains/cue-signing.keychain-db"
KCPW=cue

[ -f "$KC" ] || security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "$KCPW" "$KC"

if ! security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; then
  echo "[cue] creating the one-time local signing certificate '$NAME'"
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  cat > "$T/o.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$T/k.pem" -out "$T/c.pem" -config "$T/o.cnf" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$T/k.pem" -in "$T/c.pem" -out "$T/c.p12" -passout pass:cue 2>/dev/null
  security import "$T/c.p12" -k "$KC" -P cue -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null
fi

# codesign only finds the identity when its keychain is on the search list.
security list-keychains -d user | grep -q cue-signing || security list-keychains -d user -s "$HOME/Library/Keychains/login.keychain-db" "$KC"

# Sign by hash, inside-out (--deep fails on Electron's framework symlinks). No trust
# setting needed, and the designated requirement (bundle id + this cert) is the same
# on every rebuild, which is what keeps the macOS permission grants.
HASH="$(security find-certificate -c "$NAME" -Z "$KC" | awk '/SHA-1 hash:/ {print $3; exit}')"
sign() { codesign --force --sign "$HASH" --entitlements build-resources/entitlements.mac.plist --options runtime "$1" 2>&1 | grep -v "replacing existing" || true; }
find "$APP/Contents" \( -name "*.dylib" -o -name "*.node" \) | while read -r f; do sign "$f"; done
for f in "$APP"/Contents/Frameworks/*.framework "$APP"/Contents/Frameworks/*.app "$APP"; do sign "$f"; done
codesign --verify --strict "$APP"
codesign -dr - "$APP" 2>&1 | grep designated
