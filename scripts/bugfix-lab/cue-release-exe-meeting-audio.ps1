# Smoke oracle — the RELEASED cue-win-x64.exe, installed the way a customer
# installs it, against the cue-windows-meeting-audio-not-started oracle.
#
# Same observation as cue-windows-meeting-audio-not-started.ps1 (which builds
# from source), but the app under test is the exact installer published on the
# GitHub release (sha256-checked), installed per-user with NSIS /S.
#
# Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0
# (2 if the observation could not be completed).
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Sha256
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = "https://github.com/Blueturboguy07/cue/releases/download/$Tag/cue-win-x64.exe"
Write-Host "== download $url =="
Invoke-WebRequest -Uri $url -OutFile cue-win-x64.exe
$size = (Get-Item cue-win-x64.exe).Length
$hash = (Get-FileHash cue-win-x64.exe -Algorithm SHA256).Hash.ToLower()
Write-Host "size=$size sha256=$hash"
if ($hash -ne $Sha256.ToLower()) { Write-Host "BUGFIX_LAB_ABSENT (could not run: sha256 mismatch)"; exit 2 }

Write-Host "== silent per-user install (NSIS /S) =="
$inst = Start-Process -FilePath (Resolve-Path cue-win-x64.exe) -ArgumentList '/S' -Wait -PassThru
Write-Host "installer exit code: $($inst.ExitCode)"
$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Filter cue.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { Write-Host "BUGFIX_LAB_ABSENT (could not run: installed cue.exe not found)"; exit 2 }
Write-Host "installed: $($exe.FullName)"
$appDir = Join-Path $exe.DirectoryName 'resources\app'
$pkg = Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json
Write-Host "installed package version: $($pkg.version)"
$build = Get-Content (Join-Path $appDir 'src\publik-build.json') -Raw | ConvertFrom-Json
Write-Host "publik-build.json appToken length: $($build.appToken.Length) (value not printed)"
$card = Join-Path $appDir 'renderer\publik-card.js'
Write-Host "v0.2.8 publik-first: renderer/publik-card.js present=$(Test-Path $card)"
if (Test-Path $card) { Write-Host "publik-card.js 'Sign in with publik' lines: $((Select-String -Path $card -Pattern 'Sign in with publik').Count)" }
$loopback = Select-String -Path (Join-Path $appDir 'main.js') -Pattern "audio: 'loopback'" | Select-Object -First 1
Write-Host "main.js loopback handler: $($loopback.LineNumber): $($loopback.Line.Trim())"
$batcher = Test-Path (Join-Path $appDir 'src\publik-stt-batcher.js')
Write-Host "v0.2.7 fix files: publik-stt-batcher.js present=$batcher"
$vision = (Select-String -Path (Join-Path $appDir 'src\llm.js') -Pattern 'publikVisionModel').Count
Write-Host "v0.2.7 fix markers: llm.js publikVisionModel lines=$vision"

$env:NODE_PATH = (Resolve-Path 'cdp-deps\node_modules').Path
$outLog = "cue-main-process.log"

Write-Host "== FRESH launch of installed cue.exe (publik-first first screen probe) =="
Get-Process -Name cue -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:LAUNCH_MS = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$proc = Start-Process -FilePath $exe.FullName -ArgumentList "--remote-debugging-port=9223" `
  -RedirectStandardOutput "publik-probe.log" -RedirectStandardError "publik-probe.log.err" -PassThru -WindowStyle Normal
$env:CDP_PORT = "9223"
node scripts/bugfix-lab/cdp-publik-first.js > publik-first.json
Write-Host "publik first: $(Get-Content publik-first.json -Raw)"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name cue -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Write-Host "== launch installed cue.exe with remote debugging (meeting audio oracle) =="
$proc = Start-Process -FilePath $exe.FullName -ArgumentList "--remote-debugging-port=9222" `
  -RedirectStandardOutput $outLog -RedirectStandardError "$outLog.err" -PassThru -WindowStyle Normal
Start-Sleep -Seconds 8
$env:CDP_PORT = "9222"
Write-Host "== running CDP observer (scripts/bugfix-lab/cdp-observe.js) =="
node scripts/bugfix-lab/cdp-observe.js > cdp-result.json
$cdpExit = $LASTEXITCODE

$result = $null
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

Write-Host "== play speech on the system output for the loopback level check (session still running) =="
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SetOutputToDefaultAudioDevice()
  $synth.Speak("Please book a meeting room for the design review on Thursday at three. Tell me about a time you led a project.")
  Write-Host "speech played"
} catch { Write-Host "speech could not play: $_" }
Start-Sleep -Seconds 7
if (Test-Path $outLog) { $lv = Select-String -Path $outLog -Pattern '\[audio\]'; Write-Host "audio level lines: $($lv.Count)"; $lv | ForEach-Object { Write-Host "LEVEL $($_.Line)" } }

Write-Host "== main process log (tail) =="
if (Test-Path $outLog) { Get-Content $outLog -Tail 40 }
if (Test-Path "$outLog.err") { Get-Content "$outLog.err" -Tail 40 }
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

if ($cdpExit -eq 3 -or -not $result) {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: CDP observation did not complete)"
  exit 2
}

$errorNeedle = "Meeting audio could not be started"
$present = $false
if ($result.statusText -and $result.statusText -like "*$errorNeedle*") {
  $present = $true; $reason = "cue's own status text matched the reporters' error: '$($result.statusText)'"
} elseif ($result.getDisplayMediaOk -eq $false) {
  $present = $true; $reason = "getDisplayMedia() rejected: $($result.errorName) - $($result.errorMessage)"
} elseif ($result.getDisplayMediaOk -eq $true -and $result.audioTracks -eq 0) {
  $present = $true; $reason = "getDisplayMedia() resolved with zero audio tracks"
} elseif ($result.getDisplayMediaOk -eq $true -and $result.audioTracks -ge 1) {
  $reason = "getDisplayMedia() resolved with $($result.audioTracks) audio track(s) — meeting audio capture worked"
} else {
  Write-Host "BUGFIX_LAB_ABSENT (could not run: inconclusive result)"
  exit 2
}
Write-Host "REASON: $reason"
if ($present) { Write-Host "BUGFIX_LAB_PRESENT"; exit 1 }
Write-Host "BUGFIX_LAB_ABSENT"
exit 0
