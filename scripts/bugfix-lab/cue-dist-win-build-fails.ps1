# Oracle for cluster cue-dist-win-build-fails.
#
# Does exactly what the Windows install guide's steps 6-7 do (rendered from
# ~/publik/lib/guides/cue.ts via render-guide.mts at sourceCommit
# 90aa366ce27e8ae9f5b86f8cffa791338abdd9a2):
#   step 6 "Install dependencies": npm.cmd ci
#   step 7 "Build the installer":  npm.cmd run dist:win
# then checks the real, observable functional outcome the reporter described
# ("npm run dist:win is also not working"): did the command exit non-zero, or
# did it exit zero but produce no NSIS installer under dist/?
#
# This is not a source grep for a patch marker -- it runs the real npm/
# electron-builder toolchain on a real windows-latest runner and inspects the
# real dist/ output.
#
# Exit 1 = bug PRESENT  (dist:win failed, or no installer .exe under dist/)
# Exit 0 = bug ABSENT   (dist:win exited 0 and an installer .exe exists)
# Exit 2 = oracle could not run (npm ci itself failed -- not evidence either way)

$ErrorActionPreference = "Continue"
$repoRoot = (Get-Location).Path

Write-Host "=== environment ==="
node --version
npm --version
git rev-parse HEAD

Write-Host "`n=== step: npm.cmd ci (rendered guide step 'Install dependencies') ==="
npm.cmd ci
$ciExit = $LASTEXITCODE
Write-Host "npm.cmd ci exit code: $ciExit"
if ($ciExit -ne 0) {
  Write-Host "BUGFIX_LAB_RESULT: could-not-run (npm ci failed, not evidence of the packaging bug)"
  exit 2
}

Write-Host "`n=== step: npm.cmd run dist:win (rendered guide step 'Build the installer') ==="
npm.cmd run dist:win 2>&1 | Tee-Object -Variable distOutput
$distExit = $LASTEXITCODE
Write-Host "npm.cmd run dist:win exit code: $distExit"

$distDir = Join-Path $repoRoot "dist"
$installer = $null
if (Test-Path $distDir) {
  $installer = Get-ChildItem -Path $distDir -Filter "*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
}

Write-Host "`n=== dist/ contents ==="
if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Recurse | ForEach-Object { Write-Host $_.FullName }
} else {
  Write-Host "(dist/ does not exist)"
}

if ($distExit -ne 0) {
  Write-Host "`nBUGFIX_LAB_PRESENT: npm run dist:win exited $distExit -- no build was produced."
  exit 1
}

if (-not $installer) {
  Write-Host "`nBUGFIX_LAB_PRESENT: npm run dist:win exited 0 but no .exe installer was found under dist/."
  exit 1
}

Write-Host "`nBUGFIX_LAB_ABSENT: npm run dist:win exited 0 and produced installer: $($installer.FullName) ($($installer.Length) bytes)"
exit 0
