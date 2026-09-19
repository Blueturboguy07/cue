# Oracle v2 for cluster cue-dist-win-build-fails.
#
# WHY A SECOND SHAPE: the first repro attempt ran the guide's packaging step in
# the GitHub runner's OWN PowerShell session, whose execution policy is
# LocalMachine=RemoteSigned. A stock Windows 10/11 client ships
# ExecutionPolicy=Restricted, which is the environment every guide-installer in
# this cluster's population actually has (sibling report 693ba404, same day,
# same guide pin, captured the resulting text verbatim:
#   "npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
#    scripts is disabled on this system").
# So this script does NOT run the packaging command in the runner's shell. It
# runs it in a CHILD Windows PowerShell 5.1 process started with
# `-NoProfile -ExecutionPolicy Restricted`, i.e. a faithful stand-in for the
# PowerShell window the guide tells the reader to open (guide step 1 is
# literally "Open PowerShell"). It also strips the CI environment variables
# (CI / GITHUB_ACTIONS / CONTINUOUS_INTEGRATION / BUILD_NUMBER / GITHUB_RUN_ID)
# from that child process, because electron-builder changes behaviour when it
# detects CI and a real desktop has none of them -- that confound is what made
# the first attempt's negative control fail for the wrong reason.
#
# It is parameterised by the two things that actually differ between the
# artifact TODAY'S population runs and the artifact the AUG 6 REPORTERS ran:
#   -AppRef   the commit the guide pins (guide sourceCommit)
#   -DistCmd  the guide's "Build the installer" command, verbatim
# so the SAME oracle can be pointed at either artifact.
#
# Observed behaviour (never a source grep): clone the app at -AppRef, install
# with the policy-proof npm.cmd shim (so the variable under test is the
# packaging step alone), then run -DistCmd in the stock-policy shell and look
# at the real exit code and the real dist/ directory.
#
# Exit 1 = bug PRESENT  (the build command failed, or produced no installer)
# Exit 0 = bug ABSENT   (exit 0 and an installer .exe exists under dist/)
# Exit 2 = oracle could not run (clone or dependency install failed)

param(
  [string]$AppRef  = "90aa366ce27e8ae9f5b86f8cffa791338abdd9a2",
  [string]$DistCmd = "npm.cmd run dist:win"
)

$ErrorActionPreference = "Continue"

$work = Join-Path $env:RUNNER_TEMP ("cue-" + $AppRef.Substring(0,7))
if (Test-Path $work) { Remove-Item -Recurse -Force $work }

Write-Host "=== oracle parameters ==="
Write-Host "AppRef  : $AppRef"
Write-Host "DistCmd : $DistCmd"

Write-Host "`n=== environment ==="
node --version
npm.cmd --version
Write-Host "-- runner's own execution policy (NOT what a stock Windows client has):"
Get-ExecutionPolicy -List | Out-String | Write-Host
Write-Host "-- what a stock client's shell sees (child powershell.exe -ExecutionPolicy Restricted):"
& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command "Get-ExecutionPolicy; 'npm resolves to: ' + (Get-Command npm).Source"

Write-Host "`n=== guide steps 3-5: clone and check out the pinned commit ==="
git clone https://github.com/Blueturboguy07/cue.git $work
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_RESULT: could-not-run (git clone failed)"; exit 2 }
Set-Location $work
git checkout $AppRef
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_RESULT: could-not-run (git checkout $AppRef failed)"; exit 2 }
git rev-parse HEAD

Write-Host "`n=== guide step 6: install dependencies (npm.cmd ci -- policy-proof on purpose, so the packaging step is the only variable) ==="
npm.cmd ci
if ($LASTEXITCODE -ne 0) {
  Write-Host "BUGFIX_LAB_RESULT: could-not-run (npm.cmd ci failed -- not evidence about the packaging step)"
  exit 2
}

Write-Host "`n=== guide step 7: run the guide's build command in a STOCK-POLICY PowerShell window ==="
$clearCi = 'foreach ($v in ''CI'',''GITHUB_ACTIONS'',''CONTINUOUS_INTEGRATION'',''BUILD_NUMBER'',''GITHUB_RUN_ID'',''GITHUB_WORKFLOW'',''RUN_ID'',''TEAMCITY_VERSION'') { Remove-Item (''Env:'' + $v) -ErrorAction SilentlyContinue }; '
$inner = "Set-Location '" + $work + "'; " + $clearCi + $DistCmd + '; exit $LASTEXITCODE'
Write-Host "child command: $inner"
& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command $inner 2>&1 | Tee-Object -Variable distOut
$distExit = $LASTEXITCODE
Write-Host "`n'$DistCmd' exit code (stock-policy shell): $distExit"

$distDir = Join-Path $work "dist"
Write-Host "`n=== dist/ contents ==="
$installer = $null
if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Recurse | ForEach-Object { Write-Host ("  " + $_.FullName + "  " + $_.Length) }
  $installer = Get-ChildItem -Path $distDir -Filter "*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
  Write-Host "  (dist/ does not exist)"
}

$firstErr = ($distOut | Where-Object { $_ -match 'cannot be loaded|is not recognized|Error|error' } | Select-Object -First 1)

if ($distExit -ne 0) {
  Write-Host "`nBUGFIX_LAB_PRESENT: '$DistCmd' exited $distExit in a stock-policy PowerShell window. First error line: $firstErr"
  exit 1
}
if (-not $installer) {
  Write-Host "`nBUGFIX_LAB_PRESENT: '$DistCmd' exited 0 but no .exe installer exists under dist/."
  exit 1
}
Write-Host "`nBUGFIX_LAB_ABSENT: '$DistCmd' exited 0 and produced installer: $($installer.FullName) ($($installer.Length) bytes)"
exit 0
