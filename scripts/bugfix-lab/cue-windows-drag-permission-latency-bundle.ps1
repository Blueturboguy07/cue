# Oracle for cue-windows-drag-permission-latency-bundle.
#
# This cluster bundles six undifferentiated complaints from one Windows 11
# reporter. Of those, "not able to give permission for screen and microphone
# coz there is no option" is the one sub-claim this oracle can observe
# mechanically and unambiguously: main.js gates the mic/screen permission
# handshake (requestPermissions() -> createPermissionsWindow(), a 500x540
# consent window) behind `if (isMac)` in app.whenReady(), and getPermissionStatus()
# hard-codes `{ mic: 'granted', screen: 'granted' }` for every non-darwin
# platform. On Windows the app is therefore structurally incapable of ever
# showing a permission gate, regardless of the real OS microphone/camera
# privacy toggle. This oracle does not grep for that code: it launches the
# real packaged Windows build on a live (non-headless) desktop session and
# asks Win32 directly, via EnumWindows, whether a window shaped like the
# permission-gate window (500x540) EVER appears for the cue process, while
# confirming the main 700x600 app window did appear (so a "not found" result
# means "gate never shown", not "app never started").
#
# The other five sub-claims (drag reliability, quit discoverability, API key
# "not working", latency, keyboard shortcuts) are NOT exercised here -- see
# $WORK/log.md for why each is out of reach of a single machine-checkable
# oracle from this report, and which overlaps an existing cluster.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Result($code, $msg) {
    if ($code -eq 1) { Write-Output "BUGFIX_LAB_PRESENT: $msg" }
    elseif ($code -eq 0) { Write-Output "BUGFIX_LAB_ABSENT: $msg" }
    else { Write-Output "BUGFIX_LAB_INCONCLUSIVE: $msg" }
    exit $code
}

npm ci
if ($LASTEXITCODE -ne 0) { Write-Result 2 "npm ci failed with exit $LASTEXITCODE" }

npm run pack:win
if ($LASTEXITCODE -ne 0) { Write-Result 2 "npm run pack:win failed with exit $LASTEXITCODE" }

$exe = Get-ChildItem -Path "dist" -Recurse -Filter "cue.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
    Write-Result 2 "no cue.exe found under dist/ after pack:win"
}
Write-Output "Found packaged exe: $($exe.FullName)"

# --- Win32 P/Invoke: enumerate ALL top-level windows, resolve each to its
# owning process id, and report visibility + bounding rect. Same pattern as
# the cue-windows-overlay-not-visible-for-mic-grant oracle in this campaign. ---
$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32Probe {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public class Hit {
        public IntPtr Handle; public uint Pid; public bool Visible; public string Title;
        public int Width; public int Height; public int X; public int Y;
    }

    public static List<Hit> EnumerateForPids(HashSet<uint> pids) {
        var results = new List<Hit>();
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pids.Contains(pid)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, sb.Capacity);
                RECT r;
                GetWindowRect(hWnd, out r);
                results.Add(new Hit {
                    Handle = hWnd, Pid = pid, Visible = IsWindowVisible(hWnd), Title = sb.ToString(),
                    Width = r.Right - r.Left, Height = r.Bottom - r.Top, X = r.Left, Y = r.Top
                });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

Write-Output "Launching cue.exe: $($exe.FullName)"
$proc = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 3
if ($proc.HasExited) {
    Write-Result 2 "cue.exe process exited immediately (code $($proc.ExitCode)) -- cannot test permission gating"
}

# Poll for up to 25s, collecting every distinct window rect ever seen for a
# cue.exe-owned HWND (not just the latest snapshot -- the permission window,
# if it existed, could open and be dismissed within the window).
$deadline = (Get-Date).AddSeconds(25)
$seenRects = New-Object 'System.Collections.Generic.List[string]'
$sawMainWindow = $false
$sawPermissionWindow = $false
$allPids = @()
$lastHits = @()
while ((Get-Date) -lt $deadline) {
    $cueProcs = Get-Process -Name "cue" -ErrorAction SilentlyContinue
    if ($cueProcs) {
        $allPids = $cueProcs | Select-Object -ExpandProperty Id
        $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
        foreach ($p in $allPids) { [void]$pidSet.Add([uint32]$p) }
        $hits = @([Win32Probe]::EnumerateForPids($pidSet))
        $lastHits = $hits
        foreach ($h in $hits) {
            $key = "$($h.Width)x$($h.Height)"
            if (-not $seenRects.Contains($key)) { $seenRects.Add($key) | Out-Null }
            # Main app window: createWindow() in main.js sets width:700 height:600.
            if ($h.Width -ge 650 -and $h.Width -le 750 -and $h.Height -ge 550 -and $h.Height -le 650) {
                $sawMainWindow = $true
            }
            # Permission gate window: createPermissionsWindow() sets W:500 H:540 exactly.
            if ($h.Width -ge 480 -and $h.Width -le 520 -and $h.Height -ge 520 -and $h.Height -le 560) {
                $sawPermissionWindow = $true
            }
        }
    }
    if ($sawPermissionWindow) { break }
    Start-Sleep -Milliseconds 1000
}

Write-Output "cue.exe process count: $((Get-Process -Name 'cue' -ErrorAction SilentlyContinue | Measure-Object).Count); PIDs: $($allPids -join ',')"
Write-Output "Distinct window rects seen across the poll window: $($seenRects -join '; ')"
Write-Output "Saw a main-app-shaped window (~700x600): $sawMainWindow"
Write-Output "Saw a permission-gate-shaped window (~500x540): $sawPermissionWindow"
foreach ($h in $lastHits) {
    Write-Output ("  [final snapshot] HWND=0x{0:X} pid={1} visible={2} title='{3}' rect=({4},{5},{6}x{7})" -f $h.Handle.ToInt64(), $h.Pid, $h.Visible, $h.Title, $h.X, $h.Y, $h.Width, $h.Height)
}

# Evidence screenshot of the real desktop, regardless of outcome.
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $outPath = "$env:GITHUB_WORKSPACE\bugfix-lab-desktop.png"
    if (-not $env:GITHUB_WORKSPACE) { $outPath = ".\bugfix-lab-desktop.png" }
    $bmp.Save($outPath)
    Write-Output "Saved desktop screenshot to $outPath"
} catch {
    Write-Output "Screenshot capture failed (non-fatal): $_"
}

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Get-Process -Name "cue" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (-not $sawMainWindow) {
    Write-Result 2 "cue.exe ran (PIDs: $($allPids -join ',')) but no ~700x600 main-app window was ever observed -- cannot conclude anything about permission gating from this run. Rects seen: $($seenRects -join '; ')"
}

if ($sawPermissionWindow) {
    Write-Result 0 "A ~500x540 permission-gate window WAS observed for cue.exe -- Windows does get an in-app permission prompt. Rects seen: $($seenRects -join '; ')"
} else {
    Write-Result 1 "cue.exe launched straight to its main ~700x600 window; no ~500x540 permission-gate window was EVER observed across a 25s poll -- matches the report ('not able to give permission for screen and microphone coz there is no option'). Rects seen: $($seenRects -join '; ')"
}
