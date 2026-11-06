# Prepare a windows-latest runner for the cue 0.2.13 smoke test:
#   1. confirm the virtual output (VB-CABLE, from LABSN/sound-ci-helpers) is the default playback device,
#   2. use the committed test speech (speech-A.wav, the same file as the Mac test; 53.7 s, pauses, quiet short answers, a 15 s run-on),
#   3. download the RELEASED cue-win-x64.exe, check its sha256, install it per-user (NSIS /S),
#   4. hand CUE_EXE, CUE_PROFILE, SPEECH_WAV and OUT_DIR to the next steps.
# No publik key is used: cue mints its own install key when the test signs in.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Sha256
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$out = Join-Path $PWD 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sentence = 'speech-A: see spoken-text in the tester notes (same file as the Mac test)'
Set-Content -Path (Join-Path $out 'spoken-text.txt') -Value $sentence -Encoding UTF8

Write-Host "== audio endpoints =="
Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Format-Table Status, FriendlyName -AutoSize | Out-String -Width 300 | Write-Host
try {
  Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
  Install-Module -Name AudioDeviceCmdlets -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop
  Import-Module AudioDeviceCmdlets -ErrorAction Stop
  $list = Get-AudioDevice -List
  $play = Get-AudioDevice -Playback
  if (-not $play -or $play.Name -notmatch 'CABLE') {
    $cable = $list | Where-Object { $_.Type -eq 'Playback' -and $_.Name -match 'CABLE' } | Select-Object -First 1
    if ($cable) { Set-AudioDevice -Index $cable.Index | Out-Null; Write-Host "set default playback to: $($cable.Name)" }
    $play = Get-AudioDevice -Playback
  }
  $list | Format-Table Index, Default, Type, Name -AutoSize | Out-String -Width 300 | Out-File -Encoding utf8 (Join-Path $out 'audio-devices.txt')
  Write-Host "DEFAULT_PLAYBACK: $($play.Name) (default=$($play.Default))"
  "DEFAULT_PLAYBACK: $($play.Name)" | Add-Content (Join-Path $out 'audio-devices.txt')
} catch {
  Write-Host "AudioDeviceCmdlets unavailable: $($_.Exception.Message)"
}

Write-Host "== test speech (committed file) =="
$wav = Join-Path $out 'speech-source.wav'
Copy-Item (Join-Path $PSScriptRoot 'speech-A.wav') $wav
Write-Host "speech wav: $((Get-Item $wav).Length) bytes"

Write-Host "== download $Url =="
Invoke-WebRequest -Uri $Url -OutFile cue-win-x64.exe
$hash = (Get-FileHash cue-win-x64.exe -Algorithm SHA256).Hash.ToLower()
Write-Host "size=$((Get-Item cue-win-x64.exe).Length) sha256=$hash"
if ($hash -ne $Sha256.ToLower()) { Write-Host "STOP: sha256 mismatch"; exit 2 }
$inst = Start-Process -FilePath (Resolve-Path cue-win-x64.exe) -ArgumentList '/S' -Wait -PassThru
Write-Host "installer exit code: $($inst.ExitCode)"
$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Filter cue.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { Write-Host "STOP: installed cue.exe not found"; exit 2 }
$appDir = Join-Path $exe.DirectoryName 'resources\app'
$pkg = Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json
Write-Host "installed: $($exe.FullName) version $($pkg.version)"
Select-String -Path (Join-Path $appDir 'main.js') -Pattern "audio: 'loopback'" | Select-Object -First 1 | ForEach-Object { Write-Host "main.js $($_.LineNumber): $($_.Line.Trim())" }
Select-String -Path (Join-Path $appDir 'src\llm.js') -Pattern "PUBLIK_THINKING_HEADROOM = " | ForEach-Object { Write-Host "llm.js $($_.LineNumber): $($_.Line.Trim())" }
Select-String -Path (Join-Path $appDir 'src\publik-stt-batcher.js') -Pattern "maxMs: 14000|softMs: 8000|shortReplyMs: 700|catchUpMs: 3000" | ForEach-Object { Write-Host "publik-stt-batcher.js $($_.LineNumber): $($_.Line.Trim())" }
Get-Process -Name cue -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
"version=$($pkg.version)`nsha256=$hash" | Out-File -Encoding utf8 (Join-Path $out 'installed.txt')

$prof = Join-Path $PWD 'cue-profile'
New-Item -ItemType Directory -Force -Path $prof | Out-Null
"CUE_EXE=$($exe.FullName)" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"CUE_PROFILE=$prof" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"SPEECH_WAV=$wav" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"OUT_DIR=$out" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
exit 0
