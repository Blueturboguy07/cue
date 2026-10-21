# bugfix-lab oracle (cue-20261019-c0d7c6), retry 3: two-display layouts with electron `screen` stubbed in main.
# Exit 1 (BUGFIX_LAB_PRESENT) if the toolbar Drag pill lands outside every display workArea at startup, during or
# after a drag, or after restart. Exit 0 (BUGFIX_LAB_ABSENT) if it always lies inside one.
$ErrorActionPreference = 'Stop'
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "BUGFIX_LAB_INCONCLUSIVE: npm ci failed"; exit 2 }
Write-Host "HEAD: $(git rev-parse HEAD)"
node scripts\bugfix-lab\displays-probe.cjs
$code = $LASTEXITCODE
Get-Process -Name (Get-Content node_modules\electron\path.txt -Raw).Trim().Replace('.exe','') -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($code -eq 1) { Write-Host "BUGFIX_LAB_PRESENT: pill outside every display"; exit 1 }
if ($code -eq 0) { Write-Host "BUGFIX_LAB_ABSENT: pill always inside a display"; exit 0 }
Write-Host "BUGFIX_LAB_INCONCLUSIVE: probe exit $code"; exit 2
