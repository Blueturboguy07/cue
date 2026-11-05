# Real-sound check of the RELEASED cue-win-x64.exe meeting-audio path.
#
# The runner gets a virtual audio output first (VB-CABLE, installed by the
# LABSN/sound-ci-helpers step in the workflow). This script then:
#   1. reports the audio endpoints and makes sure the default output is set,
#   2. makes a WAV of one known English sentence with Windows SAPI (to a file),
#   3. downloads the released installer, checks its sha256, installs it per-user
#      (NSIS /S) the way a customer does,
#   4. starts cue.exe with a scratch profile and CDP, and runs
#      scripts/bugfix-lab/cdp-audio-tap.js: Skip onboarding, click
#      "Start session", play the WAV on the default output, dump what cue's
#      meeting-audio path received to out\cue-them.wav (+ raw-loopback.wav),
#   5. prints cue's own [audio] level lines from the main-process log.
# No publik key is used or needed: cue captures without signing in.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Sha256,
  [Parameter(Mandatory = $true)][string]$Url
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$out = Join-Path $PWD 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sentence = 'Tell me about a time you had to meet a tight deadline, and what you learned from it.'
Set-Content -Path (Join-Path $out 'spoken-text.txt') -Value $sentence -Encoding UTF8

Write-Host "== audio service and endpoints =="
Get-Service audiosrv, AudioEndpointBuilder | Format-Table -AutoSize | Out-String | Write-Host
Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Format-Table Status, FriendlyName, InstanceId -AutoSize | Out-String -Width 300 | Tee-Object -FilePath (Join-Path $out 'audio-endpoints.txt') | Write-Host
try {
  Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
  Install-Module -Name AudioDeviceCmdlets -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop
  Import-Module AudioDeviceCmdlets -ErrorAction Stop
  $list = Get-AudioDevice -List
  $list | Format-Table Index, Default, Type, Name -AutoSize | Out-String -Width 300 | Tee-Object -FilePath (Join-Path $out 'audio-devices.txt') | Write-Host
  $play = Get-AudioDevice -Playback
  if (-not $play -or $play.Name -notmatch 'CABLE') {
    $cable = $list | Where-Object { $_.Type -eq 'Playback' -and $_.Name -match 'CABLE' } | Select-Object -First 1
    if ($cable) { Set-AudioDevice -Index $cable.Index | Out-Null; Write-Host "set default playback to: $($cable.Name)" }
    $play = Get-AudioDevice -Playback
  }
  Write-Host "DEFAULT_PLAYBACK: $($play.Name) (default=$($play.Default))"
  "DEFAULT_PLAYBACK: $($play.Name) | ID $($play.ID)" | Add-Content (Join-Path $out 'audio-devices.txt')
} catch {
  Write-Host "AudioDeviceCmdlets unavailable: $($_.Exception.Message)"
}

Write-Host "== make the known sentence with SAPI (to a file, 16 kHz mono) =="
Add-Type -AssemblyName System.Speech
$wav = Join-Path $out 'speech-source.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($wav, $fmt)
$synth.Speak($sentence)
$synth.Dispose()
Write-Host "speech wav: $((Get-Item $wav).Length) bytes, voice text: $sentence"
try { (New-Object System.Media.SoundPlayer $wav).PlaySync(); Write-Host "pre-check: SoundPlayer played the WAV on the default output without an error" }
catch { Write-Host "pre-check: SoundPlayer FAILED: $($_.Exception.Message)" }

Write-Host "== download $Url =="
Invoke-WebRequest -Uri $Url -OutFile cue-win-x64.exe
$size = (Get-Item cue-win-x64.exe).Length
$hash = (Get-FileHash cue-win-x64.exe -Algorithm SHA256).Hash.ToLower()
Write-Host "size=$size sha256=$hash"
if ($hash -ne $Sha256.ToLower()) { Write-Host "STOP: sha256 mismatch"; exit 2 }

Write-Host "== silent per-user install (NSIS /S) =="
$inst = Start-Process -FilePath (Resolve-Path cue-win-x64.exe) -ArgumentList '/S' -Wait -PassThru
Write-Host "installer exit code: $($inst.ExitCode)"
$exe = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs" -Recurse -Filter cue.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { Write-Host "STOP: installed cue.exe not found"; exit 2 }
$appDir = Join-Path $exe.DirectoryName 'resources\app'
$pkg = Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json
Write-Host "installed: $($exe.FullName) version $($pkg.version)"
$handler = Select-String -Path (Join-Path $appDir 'main.js') -Pattern "request.audio = |audio: 'loopback'" | Select-Object -First 3
$handler | ForEach-Object { Write-Host "main.js display-media audio: $($_.LineNumber): $($_.Line.Trim())" }

Write-Host "== start cue.exe (scratch profile, CDP 9222) =="
Get-Process -Name cue -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$ud = Join-Path $PWD 'cue-profile'
New-Item -ItemType Directory -Force -Path $ud | Out-Null
$log = Join-Path $out 'cue-main-process.log'
$proc = Start-Process -FilePath $exe.FullName -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$ud" `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Normal
$env:NODE_PATH = (Resolve-Path 'cdp-deps\node_modules').Path
$env:CDP_PORT = '9222'; $env:OUT_DIR = $out; $env:SPEECH_WAV = $wav
Write-Host "== CDP: Skip onboarding, Start session, play the sentence, dump cue's meeting-audio PCM =="
$brief = node scripts/bugfix-lab/cdp-audio-tap.js
Write-Host "TAP_RESULT $brief"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name cue -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "== cue's own [audio] level lines (main process) =="
if (Test-Path $log) { Select-String -Path $log -Pattern '\[audio\]|system audio|capture started|Meeting audio|loopback|display' | ForEach-Object { Write-Host "LOG $($_.Line)" } }
Get-ChildItem $out | Format-Table Name, Length -AutoSize | Out-String | Write-Host
exit 0
