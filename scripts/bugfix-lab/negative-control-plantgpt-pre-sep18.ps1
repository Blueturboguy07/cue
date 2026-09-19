# ONE-OFF negative control, NOT managed by oracle.sh (which owns
# cue-clone-step-posix-if-windows-parsererror.ps1 and regenerates it from the
# CURRENT publik guide source). This file exists once, to prove the oracle
# mechanism would have caught plantgpt's clone-step bug before it was fixed —
# LAB.md's "already_fixed" outcome requires this sensitivity proof, run
# against the older artifact/commit the reporter (45e6bcf4, 2026-08-28)
# actually had: publik commit 66c5fd0^ (261d688), guide version 6, i.e.
# BEFORE commit 66c5fd0 (2026-09-18) fixed it.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Write-Host "=== plantgpt clone step AT PUBLIK COMMIT 261d688 (pre-2026-09-18 fix, guide v6) ==="
$cmdText = @'
cd ~
if [ ! -d plantgpt/.git ]; then
git clone https://github.com/Blueturboguy07/plantgpt.git
fi
cd plantgpt
(
if ! git config --get remote.origin.url 2>/dev/null | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##' | grep -qxF "https://github.com/Blueturboguy07/plantgpt"; then
  echo "~/plantgpt already exists and is not a clean copy of this app's source. Move or rename that folder, then press Try again."
  exit 1
fi
if git status --porcelain 2>/dev/null | grep -q .; then
  echo "~/plantgpt already exists and is not a clean copy of this app's source. Move or rename that folder, then press Try again."
  exit 1
fi
git checkout 0e2cf7ae118beee65d9a07c1659de2b2ab4b85cd
)
'@
Write-Host "--- command text this population was served before 2026-09-18 ---"
Write-Host $cmdText
Write-Host "--- running it as: pwsh -NoProfile -Command <that exact text> ---"
& pwsh -NoProfile -NoLogo -Command $cmdText 1> stdout.txt 2> stderr.txt
$exitCode = $LASTEXITCODE
$stdoutText = Get-Content -Raw -Path stdout.txt -ErrorAction SilentlyContinue
$stderrText = Get-Content -Raw -Path stderr.txt -ErrorAction SilentlyContinue
Write-Host "exit code: $exitCode"
Write-Host "stdout:"
Write-Host $stdoutText
Write-Host "stderr:"
Write-Host $stderrText
$folderPath = Join-Path $HOME "plantgpt"
$cloned = Test-Path (Join-Path $folderPath ".git")
Write-Host "repo present at $folderPath with a .git : $cloned"
$parserErrorSeen = ($stderrText -match [regex]::Escape("Missing '(' after 'if' in if statement")) -or ($stderrText -match "MissingOpenParenthesisInIfStatement") -or ($stdoutText -match "MissingOpenParenthesisInIfStatement")
if ($parserErrorSeen) {
  Write-Host "NEGATIVE_CONTROL_PRESENT_PLANTGPT_PREFIX (cloned as a side effect anyway: $cloned)"
  exit 1
} else {
  Write-Host "NEGATIVE_CONTROL_ABSENT_PLANTGPT_PREFIX (cloned: $cloned) -- UNEXPECTED, this should have failed"
  exit 0
}
