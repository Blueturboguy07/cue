// Quiet keyboard capture for the cue overlay (Windows).
//
// Arms a WH_KEYBOARD_LL hook in a hidden PowerShell process. Keys are swallowed
// so the focused app underneath does not receive them, and are forwarded to cue
// over stdout. The overlay stays non-focusable → no blur / focus events on the
// app below (e.g. WindowFocusEvents test page).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_PATH = path.join(os.tmpdir(), 'cue-quiet-keyboard.ps1');

// Use a simple line protocol instead of JSON to avoid escaping hell across
// JS → PowerShell → C# layers:
//   R                          ready
//   D|<key>|<text>|<c>|<a>|<s>|<m>|<vk>   key down
//   U|<key>|<text>|<c>|<a>|<s>|<m>|<vk>   key up
// key is a token (Enter, Backspace, a, A, ...); text is the typed character if any.
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CueQuietKb {
  public const int WH_KEYBOARD_LL = 13;
  public const int WM_KEYDOWN = 0x0100;
  public const int WM_SYSKEYDOWN = 0x0104;
  public const int WM_KEYUP = 0x0101;
  public const int WM_SYSKEYUP = 0x0105;

  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct KBDLLHOOKSTRUCT {
    public uint vkCode;
    public uint scanCode;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")]
  public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll")]
  public static extern short GetKeyState(int nVirtKey);
  [DllImport("user32.dll")]
  public static extern bool GetKeyboardState(byte[] lpKeyState);
  [DllImport("user32.dll")]
  public static extern int ToUnicode(uint wVirtKey, uint wScanCode, byte[] lpKeyState,
    [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff, int cchBuff, uint wFlags);
  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
  [DllImport("user32.dll")]
  public static extern bool TranslateMessage(ref MSG lpMsg);
  [DllImport("user32.dll")]
  public static extern IntPtr DispatchMessage(ref MSG lpMsg);

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int pt_x;
    public int pt_y;
  }

  public static IntPtr Hook = IntPtr.Zero;
  public static HookProc Proc = HookCallback;

  static bool IsMod(uint vk) {
    return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C
      || vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 || vk == 0xA4 || vk == 0xA5;
  }

  static string Named(uint vk) {
    switch (vk) {
      case 0x08: return "Backspace";
      case 0x09: return "Tab";
      case 0x0D: return "Enter";
      case 0x1B: return "Escape";
      case 0x2E: return "Delete";
      case 0x25: return "ArrowLeft";
      case 0x26: return "ArrowUp";
      case 0x27: return "ArrowRight";
      case 0x28: return "ArrowDown";
      default: return null;
    }
  }

  static string ToChar(uint vk, uint scan) {
    byte[] state = new byte[256];
    GetKeyboardState(state);
    state[0x10] = (byte)((GetKeyState(0x10) & 0x8000) != 0 ? 0x80 : 0);
    state[0x11] = (byte)((GetKeyState(0x11) & 0x8000) != 0 ? 0x80 : 0);
    state[0x12] = (byte)((GetKeyState(0x12) & 0x8000) != 0 ? 0x80 : 0);
    state[0x14] = (byte)((GetKeyState(0x14) & 0x0001) != 0 ? 0x01 : 0);
    StringBuilder sb = new StringBuilder(8);
    int rc = ToUnicode(vk, scan, state, sb, sb.Capacity, 0);
    if (rc == 1) return sb.ToString();
    // dead key / multi: ignore
    return null;
  }

  static string Clean(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    // pipe is our delimiter — strip it
    return s.Replace("|", "").Replace("\r", "").Replace("\n", "");
  }

  public static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
      if (down || up) {
        KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        uint vk = info.vkCode;
        if (!IsMod(vk)) {
          bool ctrl = (GetKeyState(0x11) & 0x8000) != 0;
          bool alt = (GetKeyState(0x12) & 0x8000) != 0;
          bool shift = (GetKeyState(0x10) & 0x8000) != 0;
          bool meta = (GetKeyState(0x5B) & 0x8000) != 0 || (GetKeyState(0x5C) & 0x8000) != 0;
          string key = Named(vk);
          string text = "";
          if (key == null) {
            if (down && !ctrl && !alt && !meta) {
              string ch = ToChar(vk, info.scanCode);
              if (!string.IsNullOrEmpty(ch)) { text = ch; key = ch; }
            }
            if (key == null) key = "Vk" + vk;
          } else if (key == null) {
            key = "Vk" + vk;
          }
          string line = (down ? "D" : "U") + "|" + Clean(key) + "|" + Clean(text) + "|"
            + (ctrl ? "1" : "0") + "|" + (alt ? "1" : "0") + "|" + (shift ? "1" : "0") + "|"
            + (meta ? "1" : "0") + "|" + vk;
          Console.WriteLine(line);
          Console.Out.Flush();
          return (IntPtr)1; // swallow
        }
      }
    }
    return CallNextHookEx(Hook, nCode, wParam, lParam);
  }

  public static void Run() {
    Process cur = Process.GetCurrentProcess();
    ProcessModule mod = cur.MainModule;
    Hook = SetWindowsHookEx(WH_KEYBOARD_LL, Proc, GetModuleHandle(mod.ModuleName), 0);
    if (Hook == IntPtr.Zero) {
      Console.WriteLine("E|SetWindowsHookEx failed");
      return;
    }
    Console.WriteLine("R");
    Console.Out.Flush();
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    UnhookWindowsHookEx(Hook);
  }
}
'@
[CueQuietKb]::Run()
`;

let child = null;
let buffer = '';
let keyHandler = null;

function startQuietKeyboard(onEvent) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'quiet-keyboard is Windows-only' };
  }
  stopQuietKeyboard();
  keyHandler = onEvent;
  try {
    fs.writeFileSync(SCRIPT_PATH, PS_SCRIPT, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }

  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    child = null;
    return { ok: false, error: err.message };
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line === 'R') continue;
      if (line.startsWith('E|')) {
        console.log('[quiet-keyboard]', line.slice(2));
        continue;
      }
      const parts = line.split('|');
      if (parts.length < 8) continue;
      const msg = {
        type: parts[0] === 'D' ? 'down' : 'up',
        key: parts[1],
        text: parts[2],
        ctrl: parts[3] === '1',
        alt: parts[4] === '1',
        shift: parts[5] === '1',
        meta: parts[6] === '1',
        vk: Number(parts[7]) || 0
      };
      if (typeof keyHandler === 'function') {
        try { keyHandler(msg); } catch { /* ignore */ }
      }
    }
  });

  child.stderr.on('data', (c) => console.log('[quiet-keyboard:err]', String(c).slice(0, 300)));
  child.on('exit', (code) => {
    console.log('[quiet-keyboard] exit', code);
    child = null;
  });
  child.on('error', (err) => {
    console.log('[quiet-keyboard] error', err.message);
    child = null;
  });

  return { ok: true };
}

function stopQuietKeyboard() {
  keyHandler = null;
  buffer = '';
  if (child && !child.killed) {
    try { child.kill(); } catch { /* ignore */ }
  }
  child = null;
}

function isQuietKeyboardActive() {
  return !!(child && !child.killed);
}

module.exports = {
  startQuietKeyboard,
  stopQuietKeyboard,
  isQuietKeyboardActive
};
