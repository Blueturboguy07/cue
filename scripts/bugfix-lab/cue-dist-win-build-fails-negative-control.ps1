# NEGATIVE CONTROL for cluster cue-dist-win-build-fails -- NOT the oracle.
#
# The reporter (report 19e6233e, created 2026-08-06) ran the guide BEFORE two
# publik fixes landed on 2026-08-10: c9510c2 (switch Windows guide npm
# commands from bare `npm ...` to `npm.cmd ...`, because "npm.ps1 cannot be
# loaded: running scripts is disabled" on PowerShell's default Restricted
# policy) and b9e2b4 (repin cue's sourceCommit 36fa2b41... -> 90aa366...).
#
# This script reproduces exactly what the Aug 6 reporter's guide told them to
# run: clone/checkout sourceCommit 36fa2b41e1c20ea5d4e47bde26e39fcd43db3872,
# then run the bare (pre-fix) commands `npm ci` and `npm run dist:win` -- NOT
# the .cmd form. It exists only to prove the PRIMARY oracle (which always
# uses npm.cmd, per the cluster's own oracle text) is sensitive: that it
# would have caught the population's actual pre-fix failure mode if the
# oracle itself used the bare command.
#
# Exit 1 = the bare command failed the way the reports describe (either the
#          PowerShell script-execution block, or any other non-zero/missing
#          installer outcome).
# Exit 0 = the bare command succeeded anyway (no negative control).
# Exit 2 = could not run (checkout/npm ci failure unrelated to dist:win).

$ErrorActionPreference = "Continue"
$repoRoot = (Get-Location).Path
$oldCommit = "36fa2b41e1c20ea5d4e47bde26e39fcd43db3872"

Write-Host "=== environment ==="
node --version
npm --version
Write-Host "--- Get-ExecutionPolicy -List (context only; not the oracle signal) ---"
Get-ExecutionPolicy -List

Write-Host "`n=== checking out the pre-fix commit the Aug 6 reporter's guide pinned: $oldCommit ==="
git fetch origin $oldCommit 2>&1
git checkout $oldCommit 2>&1
git rev-parse HEAD

Write-Host "`n=== step: npm ci (bare, pre-fix guide command) ==="
npm ci
$ciExit = $LASTEXITCODE
Write-Host "npm ci exit code: $ciExit"
if ($ciExit -ne 0) {
  Write-Host "NEGCTL_RESULT: could-not-run (npm ci itself failed, not the dist:win/PowerShell signal)"
  exit 2
}

Write-Host "`n=== step: npm run dist:win (bare, pre-fix guide command, exactly as the Aug 6 reporter ran it) ==="
npm run dist:win 2>&1 | Tee-Object -Variable distOutput
$distExit = $LASTEXITCODE
Write-Host "npm run dist:win exit code: $distExit"

$isExecPolicyBlock = ($distOutput -join "`n") -match "cannot be loaded because running scripts is disabled|execution of scripts is disabled"

$distDir = Join-Path $repoRoot "dist"
$installer = $null
if (Test-Path $distDir) {
  $installer = Get-ChildItem -Path $distDir -Filter "*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($isExecPolicyBlock) {
  Write-Host "`nNEGCTL_PRESENT: bare 'npm run dist:win' was blocked by PowerShell's script-execution policy (npm.ps1), exactly the failure mode the Aug 10 fix (c9510c2) describes."
  exit 1
}

if ($distExit -ne 0 -or -not $installer) {
  Write-Host "`nNEGCTL_PRESENT: bare 'npm run dist:win' failed (exit $distExit, installer found: $([bool]$installer)) for a reason OTHER than the execution-policy block."
  exit 1
}

Write-Host "`nNEGCTL_ABSENT: bare 'npm run dist:win' succeeded anyway on this runner (installer: $($installer.FullName)); this runner's default execution policy does not reproduce the reporters' failure mode."
exit 0
