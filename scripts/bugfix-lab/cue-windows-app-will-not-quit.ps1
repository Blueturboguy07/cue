# bugfix-lab oracle — cue-windows-app-will-not-quit
#
# Population: guide-installers who followed publik's Windows guide for cue and
# built it themselves (the guide's pinned commit is what this script's own
# commit sits on top of — see oracle.sh, which force-pushes whatever commit is
# checked out onto the CI branch). Report 8d3f1d5b: "installed cue vie windows
# installation instructions... after installing app and opening via start, it
# is not closing... if i start cue from powershell and press Control+C it
# closes." Report 9b5b37e4: "How to close the cue top floating thing?" with a
# screenshot of the toolbar's Quit control.
#
# main.js creates cue's window with frame:false, skipTaskbar:true,
# alwaysOnTop:true, type:'toolbar' on Windows, and this app registers no Tray
# icon anywhere (grepped: no `Tray` in main.js). That means the in-app
# #quit-btn toolbar control is the ONLY UI path that can end a running cue
# process on Windows — there is no native title-bar close box, no taskbar
# entry to right-click, and no tray icon.
#
# This script packages cue the way the README's Windows build instructions
# say to, launches the SAME dist\win-unpacked\cue.exe a self-built reporter
# would run, dispatches a genuine CDP mouse click on #quit-btn (the same
# control shown in report 9b5b37e4's screenshot), and then observes the ONE
# thing every reporter actually describes: does the OS process end. Not a
# source grep — a real launched process, a real click, a real wait on the PID.
#
# Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0 accordingly
# (2 if the observation itself could not be completed), per LAB.md.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host "== npm ci =="
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_ABSENT (could not run: npm ci failed)"; exit 2 }

Write-Host "== npm run pack:win (same command the README's Windows build section documents) =="
npm run pack:win
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_ABSENT (could not run: pack:win failed)"; exit 2 }

$exe = "dist\win-unpacked\cue.exe"
if (-not (Test-Path $exe)) {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: $exe not found after pack:win)"
  exit 2
}

Write-Host "== launching $exe with remote debugging (no API keys configured — same as a fresh install) =="
$outLog = "cue-main-process.log"
$proc = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9222" `
  -RedirectStandardOutput $outLog -RedirectStandardError "$outLog.err" -PassThru -WindowStyle Normal

# Give the app time to boot (window creation, IPC wiring) before CDP is ready.
Start-Sleep -Seconds 6

if ($proc.HasExited) {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: cue.exe exited during startup, before any quit attempt — exit code $($proc.ExitCode))"
  exit 2
}

$env:CDP_PORT = "9222"
Write-Host "== running CDP click on #quit-btn =="
node scripts\bugfix-lab\cdp-click-quit.js > cdp-quit-result.json
$cdpExit = $LASTEXITCODE

$clickResult = $null
try {
  $clickResult = Get-Content cdp-quit-result.json -Raw | ConvertFrom-Json
  $summary = $clickResult | Select-Object ok, clicked, buttonFound, buttonObstructed, buttonTitle, buttonAriaLabel, stillConnectedAfterClick, could_not_run, reason
  Write-Host "== cdp-click-quit.js result (screenshot omitted from log; see artifact) =="
  Write-Host ($summary | ConvertTo-Json -Compress)
  if ($clickResult.screenshotBase64) {
    [IO.File]::WriteAllBytes("cue-screenshot.png", [Convert]::FromBase64String($clickResult.screenshotBase64))
  }
} catch {
  Write-Host "(could not parse cdp-quit-result.json: $_)"
}

if ($cdpExit -eq 3) {
  Write-Host "== main process log (tail) =="
  if (Test-Path $outLog) { Get-Content $outLog -Tail 60 }
  if (Test-Path "$outLog.err") { Get-Content "$outLog.err" -Tail 60 }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "BUGFIX_LAB_ABSENT (could not run: CDP click on #quit-btn did not complete)"
  exit 2
}

# THE oracle question: after a real click on the only in-UI quit control this
# app has, does the OS process actually end. Reporters describe waiting
# indefinitely, so give it a generous window, polling rather than a single
# fixed sleep so evidence can show exactly how long it took (or that it never
# happened).
$deadline = (Get-Date).AddSeconds(20)
$exitedOnOwn = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { $exitedOnOwn = $true; break }
  Start-Sleep -Milliseconds 500
}

Write-Host "== main process log (tail) =="
if (Test-Path $outLog) { Get-Content $outLog -Tail 60 }
if (Test-Path "$outLog.err") { Get-Content "$outLog.err" -Tail 60 }

$stillRunning = -not $exitedOnOwn
if ($stillRunning) {
  # Confirm it's not a fluke by re-checking Get-Process directly by PID, the
  # same signal a user checking Task Manager would see.
  $viaGetProcess = $null
  try { $viaGetProcess = Get-Process -Id $proc.Id -ErrorAction Stop } catch { $viaGetProcess = $null }
  $stillRunning = ($null -ne $viaGetProcess)
}

if ($stillRunning) {
  $reason = "clicked #quit-btn (found=$($clickResult.buttonFound), obstructed=$($clickResult.buttonObstructed), title='$($clickResult.buttonTitle)') and waited 20s: process PID $($proc.Id) is still running (confirmed via Get-Process). This matches every reporter: the only in-UI quit control does not end the process."
  Write-Host "REASON: $reason"
  Write-Host "BUGFIX_LAB_PRESENT"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
} else {
  $reason = "clicked #quit-btn and the process exited on its own (exit code $($proc.ExitCode)) — the UI quit control worked."
  Write-Host "REASON: $reason"
  Write-Host "BUGFIX_LAB_ABSENT"
  exit 0
}
