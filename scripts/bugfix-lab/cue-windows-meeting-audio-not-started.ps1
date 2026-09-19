# bugfix-lab oracle — cue-windows-meeting-audio-not-started
#
# Population: guide-installers who self-build cue at the publik guide's pinned
# commit (matches reporter 245f7947's "cue version 0.2.2, self-built via
# `npm run pack:win`"). This script packages cue exactly the way the README's
# Windows build instructions say to, launches the SAME dist\win-unpacked\cue.exe
# the reporter ran, clicks the same "Start / stop listening" button, and reads
# cue's own on-screen status text plus the real return value of the browser
# API cue calls (navigator.mediaDevices.getDisplayMedia) via CDP.
#
# Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0 accordingly
# (2 if the observation itself could not be completed), per LAB.md.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host "== npm ci =="
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_ABSENT (could not run: npm ci failed)"; exit 2 }

Write-Host "== npm run pack:win (same command the reporter used) =="
npm run pack:win
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_ABSENT (could not run: pack:win failed)"; exit 2 }

$exe = "dist\win-unpacked\cue.exe"
if (-not (Test-Path $exe)) {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: $exe not found after pack:win)"
  exit 2
}

Write-Host "== launching $exe with remote debugging =="
$outLog = "cue-main-process.log"
$proc = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9222" `
  -RedirectStandardOutput $outLog -RedirectStandardError "$outLog.err" -PassThru -WindowStyle Normal

# Give the app time to boot (window creation, IPC wiring) before CDP is ready.
Start-Sleep -Seconds 6

$env:CDP_PORT = "9222"
Write-Host "== running CDP observer =="
node scripts/bugfix-lab/cdp-observe.js > cdp-result.json
$cdpExit = $LASTEXITCODE

# NOTE: deliberately do NOT Get-Content the raw file to the console — it
# embeds an ~80-100KB base64 screenshot as one giant line, and a line that
# size has been observed to truncate everything GitHub Actions logs AFTER it
# within the same step (the BUGFIX_LAB_PRESENT/ABSENT marker below went
# missing from `gh run view --log` this way in an earlier run of this exact
# script — confirmed by downloading the artifact and finding it intact
# there). Print a redacted summary instead; the full JSON (with screenshot)
# still goes to the uploaded artifact untouched.
try {
  $result = Get-Content cdp-result.json -Raw | ConvertFrom-Json
  $summary = $result | Select-Object ok, called, settled, getDisplayMediaOk, audioTracks, videoTracks, errorName, errorMessage, statusText, consoleLines
  Write-Host "== cdp-observe.js result (screenshot omitted from log; see artifact) =="
  Write-Host ($summary | ConvertTo-Json -Compress)
  if ($result.screenshotBase64) {
    [IO.File]::WriteAllBytes("cue-screenshot.png", [Convert]::FromBase64String($result.screenshotBase64))
  }
} catch {
  Write-Host "(could not parse/decode cdp-result.json: $_)"
}

Write-Host "== main process log (tail) =="
if (Test-Path $outLog) { Get-Content $outLog -Tail 60 }
if (Test-Path "$outLog.err") { Get-Content "$outLog.err" -Tail 60 }

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

if ($cdpExit -eq 3) {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: CDP observation did not complete)"
  exit 2
}

$statusText = $result.statusText
$getDisplayMediaOk = $result.getDisplayMediaOk
$audioTracks = $result.audioTracks

# The exact, verbatim string every reporter in this cluster saw.
$errorNeedle = "Meeting audio could not be started"

$present = $false
$reason = ""

if ($statusText -and $statusText -like "*$errorNeedle*") {
  $present = $true
  $reason = "cue's own #cue-status text matched the reporters' error verbatim: '$statusText'"
} elseif ($getDisplayMediaOk -eq $false) {
  $present = $true
  $reason = "navigator.mediaDevices.getDisplayMedia() rejected: $($result.errorName) - $($result.errorMessage)"
} elseif ($getDisplayMediaOk -eq $true -and $audioTracks -eq 0) {
  $present = $true
  $reason = "getDisplayMedia() resolved but produced zero audio tracks (the 'screen captured, audio never heard' shape reporters describe)"
} elseif ($getDisplayMediaOk -eq $true -and $audioTracks -ge 1) {
  $present = $false
  $reason = "getDisplayMedia() resolved with $audioTracks audio track(s) — meeting audio capture worked"
} else {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: inconclusive result — $($result | ConvertTo-Json -Compress))"
  exit 2
}

Write-Host "REASON: $reason"

if ($present) {
  Write-Host "BUGFIX_LAB_PRESENT"
  exit 1
} else {
  Write-Host "BUGFIX_LAB_ABSENT"
  exit 0
}
