# bugfix-lab oracle for cue-windows-multiline-paste-collapses-commands.
#
# Simulates a Windows reader who (1) clicks "Copy" on the cue install guide's
# "enter-folder" step ("cd cue"), pastes into PowerShell WITHOUT pressing
# Enter, then (2) clicks "Copy" on the very next step ("pin-source", the
# reviewed-commit checkout block) and pastes it right after — again with no
# Enter in between. That is exactly two clipboard payloads concatenated with
# NO separating newline, which is what `payload/paste-collapsed.txt` holds
# (built by oracle-src/extract-payload.mjs from the REAL, shipped
# `commandToRun()` in iris-windows/src/renderer/guide/app.js and the REAL
# guide step data rendered from publik's lib/guides/cue.ts).
#
# `payload/paste-with-enter.txt` is the control: the same two clipboard
# payloads, but with the Enter the reader is supposed to press between them —
# i.e. block1 + "`n" + block2. It proves the harness is sensitive: run against
# a real clone with a matching origin remote, this control must successfully
# check out the pinned commit.
#
# Exit 1 = bug present (paste collapsed onto one line, checkout never
#          happened). Exit 0 = bug absent (both payloads execute correctly
#          regardless of paste grouping). Exit 2 = the oracle itself could not
#          run (network, tooling).
#
# Usage: .\cue-windows-multiline-paste-collapses-commands.ps1
# (no args — payload lives alongside this script at .\payload\, matching every
# other cluster's bugfix-lab.yml invocation `.\scripts\bugfix-lab\<key>.ps1`)

$ErrorActionPreference = "Stop"

$PayloadDir = Join-Path $PSScriptRoot "payload"
$CloneUrl = "https://github.com/Blueturboguy07/cue.git"
$PinnedSha = "90aa366ce27e8ae9f5b86f8cffa791338abdd9a2"

$scratchRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }

function New-ScratchHome([string]$label) {
  $dir = Join-Path $scratchRoot "bugfix-lab-home-$label-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  return $dir
}

function Clone-Cue([string]$homeDir) {
  $cuePath = Join-Path $homeDir "cue"
  & git clone --quiet $CloneUrl $cuePath 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit $LASTEXITCODE" }
  return $cuePath
}

# Runs a payload script AS IF it were pasted into a fresh PowerShell console
# whose $HOME/`~` is $homeDir, and returns [pscustomobject]@{ExitCode; Output}.
function Invoke-PastedPayload([string]$payloadPath, [string]$homeDir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
  if (-not $psi.FileName) { $psi.FileName = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
  if (-not $psi.FileName) { throw "neither powershell.exe nor pwsh found" }
  # -Command - reads the script from stdin, exactly as a pasted multi-line
  # block is fed to the console's input stream: newlines in the text are the
  # ONLY thing separating statements, precisely what this bug is about.
  $psi.Arguments = "-NoLogo -NoProfile -NonInteractive -Command -"
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  # The payload's own first line is literally "cd ~" / "cd $HOME-relative" —
  # `~` resolves off these two environment variables in the FileSystem
  # provider (USERPROFILE on Windows PowerShell 5.1, HOME on pwsh 7).
  $psi.EnvironmentVariables["USERPROFILE"] = $homeDir
  $psi.EnvironmentVariables["HOME"] = $homeDir

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $stdin = $proc.StandardInput
  $payloadText = Get-Content -Path $payloadPath -Raw
  $stdin.Write($payloadText)
  $stdin.Close()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $proc.ExitCode
    Output   = "$stdout`n$stderr"
  }
}

Write-Host "== setting up two independent scratch homes =="
$homePresent = New-ScratchHome "present"
$homeControl = New-ScratchHome "control"
Write-Host "present-case home: $homePresent"
Write-Host "control-case home: $homeControl"

Write-Host "== cloning real cue repo into each ($CloneUrl) =="
$cuePresent = Clone-Cue $homePresent
$cueControl = Clone-Cue $homeControl
$originalHeadPresent = (& git -C $cuePresent rev-parse HEAD).Trim()
Write-Host "clone HEAD before paste: $originalHeadPresent"

# ---- Case A: the bug's trigger — the two copy-paste actions with no Enter between them ----
Write-Host "`n== running paste-collapsed.txt (no Enter between the two copies) against $cuePresent =="
$collapsedPayload = Join-Path $PayloadDir "paste-collapsed.txt"
$resultPresent = Invoke-PastedPayload $collapsedPayload $homePresent
Write-Host "--- output ---"
Write-Host $resultPresent.Output
Write-Host "--- exit code: $($resultPresent.ExitCode) ---"

$sawSetLocationError = $resultPresent.Output -match "positional parameter cannot be found that accepts argument"
$headAfterCollapsed = (& git -C $cuePresent rev-parse HEAD).Trim()
$checkoutHappenedDespiteCollapse = ($headAfterCollapsed -eq $PinnedSha)
Write-Host "saw Set-Location positional-parameter error: $sawSetLocationError"
Write-Host "HEAD after collapsed paste: $headAfterCollapsed (pinned=$PinnedSha) — checked out despite collapse: $checkoutHappenedDespiteCollapse"

# Functional outcome named directly in the report: "the shell never actually
# entered the repo" — confirm independently, unsuppressed, exactly the
# diagnostic a confused reader would see if they then ran `git status` (or a
# bare `git checkout`) themselves in the directory the collapsed cd actually
# left them in.
Write-Host "`n== unsuppressed git status in the directory the collapsed paste actually left us in =="
Push-Location $homePresent
$gitStatusOutput = (& git status 2>&1 | Out-String)
Pop-Location
Write-Host $gitStatusOutput
$sawNotAGitRepoError = $gitStatusOutput -match "not a git repository"

# ---- Case B: control — same two payloads, WITH the Enter a careful reader presses ----
Write-Host "`n== running paste-with-enter.txt (Enter pressed between the two copies) against $cueControl =="
$controlPayload = Join-Path $PayloadDir "paste-with-enter.txt"
$resultControl = Invoke-PastedPayload $controlPayload $homeControl
Write-Host "--- output ---"
Write-Host $resultControl.Output
Write-Host "--- exit code: $($resultControl.ExitCode) ---"
$headAfterControl = (& git -C $cueControl rev-parse HEAD).Trim()
$controlCheckedOutPinned = ($headAfterControl -eq $PinnedSha)
Write-Host "HEAD after control paste: $headAfterControl (pinned=$PinnedSha) — checked out pinned commit: $controlCheckedOutPinned"

if (-not $controlCheckedOutPinned) {
  Write-Host "`nORACLE COULD NOT RUN: the control payload (Enter pressed between pastes) did not"
  Write-Host "check out the pinned commit either, so this harness cannot tell present from absent."
  exit 2
}

Write-Host "`n=================== VERDICT ==================="
if ($sawSetLocationError -and -not $checkoutHappenedDespiteCollapse) {
  Write-Host "BUG PRESENT: the no-Enter-between-pastes payload collapsed 'cd cue' and 'cd ~/cue' onto"
  Write-Host "one line, PowerShell raised the positional-parameter error on the merged line, and the"
  Write-Host "pinned commit was never checked out (HEAD stayed at $headAfterCollapsed)."
  if ($sawNotAGitRepoError) {
    Write-Host "Also observed (unsuppressed) the follow-on git error a reader would hit next: 'not a git repository'."
  }
  Write-Host "Control payload (Enter pressed) succeeded, so the harness is sensitive."
  exit 1
} else {
  Write-Host "BUG ABSENT: the no-Enter-between-pastes payload executed each line as its own statement"
  Write-Host "regardless of paste grouping — no Set-Location error, and HEAD ended at the pinned commit."
  exit 0
}
