#!/usr/bin/env bash
# accept_run.sh --script PATH --head DIR --base DIR [--runs N] [--timeout SECONDS] [--interp CMD] [--summary FILE]
#
# Runs an acceptance script against two checkouts, N times each:
#   <interp> PATH <dir>      exit 0 = problem ABSENT, 1 = problem PRESENT, 2 = cannot run
# The fix is proved when the problem is PRESENT at --base (exit 1) and ABSENT at --head (exit 0)
# on EVERY run.
#
# Exit codes of this script
#   0  base = 1 and head = 0 on every run
#   1  consistent but wrong (the problem is still present at head, or already absent at base)
#   2  cannot run: a run exited with something other than 0 or 1, timed out, or the script is missing
#   3  flaky: the runs at one checkout disagree (a mix of 0 and 1)
#
# --interp defaults to `bash`; use `pwsh -NoProfile -File` for accept.ps1.
# A markdown table goes to stdout and is appended to --summary (the workflow passes $GITHUB_STEP_SUMMARY).
# The script runs with the checkout as its working directory, with a timeout that also works on macOS.
set -uo pipefail

SCRIPT="" HEAD_DIR="" BASE_DIR="" RUNS=2 TIMEOUT=600 INTERP="bash" SUMMARY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --script) SCRIPT=$2; shift 2 ;;
    --head) HEAD_DIR=$2; shift 2 ;;
    --base) BASE_DIR=$2; shift 2 ;;
    --runs) RUNS=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --interp) INTERP=$2; shift 2 ;;
    --summary) SUMMARY=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$SCRIPT" ] || [ -z "$HEAD_DIR" ] || [ -z "$BASE_DIR" ]; then
  echo "usage: accept_run.sh --script PATH --head DIR --base DIR [--runs N] [--timeout S] [--interp CMD] [--summary FILE]" >&2
  exit 2
fi
case "$RUNS" in ''|*[!0-9]*) echo "--runs must be a number" >&2; exit 2 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) echo "--timeout must be a number" >&2; exit 2 ;; esac
[ "$RUNS" -ge 1 ] || { echo "--runs must be at least 1" >&2; exit 2; }

ROWS=""
cannot=0
declare -a HEAD_RC=() BASE_RC=()

# run_once <label> <dir>  -> sets LAST_RC (0/1/2.. or 124 for timeout) and LAST_SECS
run_once() {
  local dir=$1 marker pid wd start sarg darg
  LAST_RC=2; LAST_SECS=0
  if [ ! -f "$SCRIPT" ]; then LAST_RC=2; return; fi
  if [ ! -d "$dir" ]; then LAST_RC=2; return; fi
  marker=$(mktemp "${TMPDIR:-/tmp}/accept-timeout.XXXXXX")
  rm -f "$marker"
  start=$(date +%s)
  set -m
  # PowerShell under Git Bash needs Windows paths for the script and the directory argument.
  sarg=$SCRIPT; darg=$dir
  case "$INTERP" in
    *pwsh*|*powershell*) if command -v cygpath >/dev/null 2>&1; then sarg=$(cygpath -w "$SCRIPT"); darg=$(cygpath -w "$dir"); fi ;;
  esac
  # shellcheck disable=SC2086
  ( cd "$dir" && exec $INTERP "$sarg" "$darg" ) </dev/null &
  pid=$!
  ( sleep "$TIMEOUT"; : > "$marker"; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 3; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  { wait "$pid"; LAST_RC=$?; } 2>/dev/null
  set +m
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  LAST_SECS=$(( $(date +%s) - start ))
  if [ -e "$marker" ]; then LAST_RC=124; rm -f "$marker"; fi
}

meaning() {  # exit code -> words
  case "$1" in
    0) echo "absent" ;; 1) echo "PRESENT" ;; 2) echo "cannot run" ;; 124) echo "TIMEOUT" ;; *) echo "error" ;;
  esac
}

for i in $(seq 1 "$RUNS"); do
  for target in base head; do
    dir=$HEAD_DIR; [ "$target" = base ] && dir=$BASE_DIR
    run_once "$dir"
    if [ "$target" = base ]; then BASE_RC+=("$LAST_RC"); else HEAD_RC+=("$LAST_RC"); fi
    case "$LAST_RC" in 0|1) ;; *) cannot=1 ;; esac
    ROWS="${ROWS}| ${i} | ${target} | ${LAST_RC} | $(meaning "$LAST_RC") | ${LAST_SECS}s |
"
  done
done

verdict=0
mixed() { local a=("$@") first="${1}" x; for x in "${a[@]}"; do [ "$x" != "$first" ] && return 0; done; return 1; }

if [ "$cannot" -eq 1 ]; then
  verdict=2; word="CANNOT RUN (a run exited with something other than 0 or 1, or timed out)"
elif mixed "${BASE_RC[@]}" || mixed "${HEAD_RC[@]}"; then
  verdict=3; word="FLAKY (runs at one checkout disagree)"
elif [ "${BASE_RC[0]}" = 1 ] && [ "${HEAD_RC[0]}" = 0 ]; then
  verdict=0; word="PASS (problem present at base, absent at head, on every run)"
else
  verdict=1
  if [ "${BASE_RC[0]}" = 0 ]; then word="FAIL (problem already absent at base: the script proves nothing)"
  else word="FAIL (problem still present at head)"; fi
fi

TABLE="### Acceptance: ${word}

Expected: base exit 1 (problem PRESENT), head exit 0 (problem ABSENT), ${RUNS} run(s) each.

| run | checkout | exit | meaning | time |
|---|---|---|---|---|
${ROWS}"
printf '%s\n' "$TABLE"
if [ -n "$SUMMARY" ]; then printf '%s\n' "$TABLE" >> "$SUMMARY"; fi
exit "$verdict"
