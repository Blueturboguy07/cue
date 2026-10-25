#!/bin/bash
# exit 0 = user can find where to add a Deepgram key in the UI; 1 = not; 2 = cannot run
D="$1"; [ -d "$D" ] || { echo "EVIDENCE: no dir"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d); export HOME="$T/home"; mkdir -p "$HOME"
cp -R "$D" "$T/app" && cd "$T/app" || exit 2
npm ci --no-audit --no-fund >"$T/npm.log" 2>&1 || { echo "EVIDENCE: npm ci failed"; exit 2; }
node node_modules/electron/install.js >>"$T/npm.log" 2>&1
E=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
[ -x "$E" ] || { echo "EVIDENCE: electron binary missing"; exit 2; }
PORT=$((20000+RANDOM%10000))
"$E" . --remote-debugging-port=$PORT --user-data-dir="$HOME/ud" >"$T/app.log" 2>&1 &
PID=$!
RC=2
for i in $(seq 1 20); do sleep 2; node "$HERE/cdp.mjs" $PORT 2>/dev/null; RC=$?; [ $RC -ne 2 ] && break; done
[ $RC -eq 2 ] && echo "EVIDENCE: main window never appeared (blocked on macOS permissions window)"
kill $PID 2>/dev/null; pkill -f "$T/app" 2>/dev/null
exit $RC
