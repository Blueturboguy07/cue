# bugfix-lab oracle (cue-20261019-c0d7c6): "I installed thru iris and im unable to move the window" (Windows).
# Runs the app the way the guide leaves it (npm ci, then electron . from the checkout), then drags the
# toolbar's "Drag" pill with the REAL OS mouse (SetCursorPos + mouse_event), and reads the real top-level
# window rectangle with Win32 before and after. Window did not follow the cursor => PRESENT (exit 1).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Done($code, $msg) {
  if ($code -eq 1) { Write-Host "BUGFIX_LAB_PRESENT: $msg" } elseif ($code -eq 0) { Write-Host "BUGFIX_LAB_ABSENT: $msg" } else { Write-Host "BUGFIX_LAB_INCONCLUSIVE: $msg" }
  Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  exit $code
}

npm ci
if ($LASTEXITCODE -ne 0) { Done 2 "npm ci failed ($LASTEXITCODE)" }
Write-Host "HEAD: $(git rev-parse HEAD)"

Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static string BigWindow(HashSet<uint> pids) {
    string best = ""; long area = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); RECT r;
      if (pids.Contains(p) && IsWindowVisible(h) && GetWindowRect(h, out r)) { long a = (long)(r.R - r.L) * (r.B - r.T);
        if (a > area) { area = a; best = r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T); } } return true; }, IntPtr.Zero);
    return best;
  }
}
'@
function WinRect {
  $s = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-Process -Name electron -ErrorAction SilentlyContinue | ForEach-Object { [void]$s.Add([uint32]$_.Id) }
  return [W]::BigWindow($s)
}
function Mouse($flag) { [W]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero) }
$LEFTDOWN = 2; $LEFTUP = 4

$vs = "$([W]::GetSystemMetrics(0))x$([W]::GetSystemMetrics(1))"
Write-Host "primary screen: $vs"

$env:CDP_PORT = '9222'
$proc = Start-Process -FilePath "node_modules\electron\dist\electron.exe" -ArgumentList ".", "--remote-debugging-port=9222" `
  -RedirectStandardOutput "cue-main-process.log" -RedirectStandardError "cue-main-process.log.err" -PassThru
Start-Sleep -Seconds 8
if ($proc.HasExited) { Get-Content cue-main-process.log.err -Tail 30; Done 2 "electron exited at startup ($($proc.ExitCode))" }

$prepJson = node scripts\bugfix-lab\drag-probe.cjs prep
if ($LASTEXITCODE -ne 0) { Get-Content cue-main-process.log.err -Tail 30; Done 2 "CDP prep failed" }
Write-Host "prep: $prepJson"
$prep = $prepJson | ConvertFrom-Json
$before = WinRect
Write-Host "window rect before (x,y,w,h): $before"
if (-not $before) { Done 2 "no visible top-level cue window found" }

# Hover first, as a person would: lets the renderer drop click-through over the toolbar.
[void][W]::SetCursorPos($prep.x - 40, $prep.y); Start-Sleep -Milliseconds 300
[void][W]::SetCursorPos($prep.x, $prep.y); Start-Sleep -Milliseconds 500
$cp = New-Object W+POINT; [void][W]::GetCursorPos([ref]$cp)
Write-Host "cursor at ($($cp.X),$($cp.Y)), wanted ($($prep.x),$($prep.y))"
Mouse $LEFTDOWN; Start-Sleep -Milliseconds 300
$dx = 0; $dy = 0
for ($i = 1; $i -le 20; $i++) {
  $dx = 10 * $i; $dy = 6 * $i
  [void][W]::SetCursorPos($prep.x + $dx, $prep.y + $dy); Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 300
$during = WinRect
Mouse $LEFTUP; Start-Sleep -Milliseconds 600
$after = WinRect
$st = node scripts\bugfix-lab\drag-probe.cjs state
Write-Host "window rect during drag: $during"
Write-Host "window rect after release: $after"
Write-Host "renderer state: $st"
Write-Host "cursor travelled (+$dx,+$dy)"
try {
  Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save("$PWD\bugfix-lab-desktop.png")
} catch { Write-Host "screenshot failed: $_" }
Get-Content cue-main-process.log.err -Tail 15 -ErrorAction SilentlyContinue

$b = $before.Split(',') | ForEach-Object { [int]$_ }
$a = $after.Split(',') | ForEach-Object { [int]$_ }
$moved = [math]::Abs($a[0] - $b[0]) + [math]::Abs($a[1] - $b[1])
if ($moved -ge 100) { Done 0 "window moved with the cursor (rect $before -> $after)" }
Done 1 "dragged the toolbar by (+$dx,+$dy) with the real mouse; window rect $before -> $after (moved $moved px)"
