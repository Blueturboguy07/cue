// Run installed coding CLIs as chat backends so cue can use a logged-in
// Claude Code / Codex / Grok CLI session without pasting API keys.
//
// stream({ provider, model, system, turns, imageDataUrl, onToken }) -> fullText

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_PROVIDERS = new Set(['claude-cli', 'codex-cli', 'grok-cli']);

function isCliProvider(provider) {
  return CLI_PROVIDERS.has(provider);
}

function whichCmd(name) {
  // Prefer PATH resolution via where/which executed once per process is fine.
  // On Windows, spawn with shell:false needs a real .cmd/.exe path sometimes.
  if (process.platform !== 'win32') return name;
  const candidates = [];
  const pathEnv = process.env.PATH || '';
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) candidates.push(p);
      } catch { /* ignore */ }
    }
  }
  // Known install locations
  if (name === 'grok') {
    const g = path.join(os.homedir(), '.grok', 'bin', 'grok.exe');
    if (fs.existsSync(g)) candidates.unshift(g);
  }
  if (name === 'codex') {
    const c = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (c && fs.existsSync(c)) candidates.unshift(c);
  }
  return candidates[0] || name;
}

function writeTempImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
  const file = path.join(os.tmpdir(), `cue-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

function buildUserPrompt(turns, imagePath) {
  const parts = [];
  for (const t of turns || []) {
    const role = t.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${role}: ${t.text || ''}`);
  }
  let text = parts.join('\n\n');
  if (imagePath) {
    text += `\n\n[A screenshot is attached at: ${imagePath}]`;
  }
  return text;
}

function runProcess(bin, args, { onStdoutLine, onStdoutChunk, onActivity, stdinText = null, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const useShell = process.platform === 'win32' && !/\.exe$/i.test(bin);
      child = spawn(bin, args, {
        windowsHide: true,
        shell: useShell,
        // Always open stdin so CLIs that probe for a TTY/pipe do not hang waiting.
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`CLI timed out after ${Math.round(timeoutMs / 1000)}s (${path.basename(bin)})`));
    }, timeoutMs);

    try {
      if (stdinText != null) child.stdin.write(String(stdinText));
      child.stdin.end();
    } catch { /* ignore broken pipe */ }

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      stdout += chunk;
      if (onActivity) onActivity();
      if (onStdoutChunk) onStdoutChunk(chunk);
      if (onStdoutLine) {
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, '');
          lineBuf = lineBuf.slice(idx + 1);
          if (line) onStdoutLine(line);
        }
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
      // Progress / status on stderr also means the CLI is still alive.
      if (onActivity) onActivity();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (onStdoutLine && lineBuf.trim()) onStdoutLine(lineBuf.replace(/\r$/, ''));
      if (code && code !== 0) {
        const detail = (stderr || stdout || '').trim().slice(0, 400);
        reject(new Error(`${path.basename(bin)} exited ${code}${detail ? ': ' + detail : ''}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Claude Code CLI — uses the logged-in `claude` session (no API key in cue).
 */
async function streamClaudeCli({ model, system, turns, imageDataUrl, onToken, onActivity }) {
  const bin = whichCmd('claude');
  const imagePath = writeTempImage(imageDataUrl);
  const userPrompt = buildUserPrompt(turns, imagePath);
  const args = [
    '-p',
    '--output-format', 'text',
    '--permission-mode', 'bypassPermissions',
    '--tools', ''
  ];
  if (system) {
    args.push('--system-prompt', system);
  }
  if (model) {
    args.push('--model', model);
  }
  // Prompt via stdin avoids Windows argv length / quoting issues.
  // claude -p reads the prompt from stdin when no prompt arg is given.

  let full = '';
  try {
    const { stdout } = await runProcess(bin, args, {
      stdinText: userPrompt,
      onActivity,
      onStdoutChunk: (chunk) => {
        // text mode: stream raw chunks
        full += chunk;
        if (onToken) onToken(chunk);
      }
    });
    const text = (full || stdout || '').trim();
    if (!text) throw new Error('Claude CLI returned an empty response. Run `claude` and sign in, then try again.');
    // If we already streamed, avoid double-counting
    if (!full && onToken) onToken(text);
    return text;
  } finally {
    if (imagePath) try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
  }
}

/**
 * OpenAI Codex CLI — uses the logged-in `codex` session.
 * Emits JSONL events; we take agent_message text.
 */
async function streamCodexCli({ model, system, turns, imageDataUrl, onToken, onActivity }) {
  const bin = whichCmd('codex');
  const imagePath = writeTempImage(imageDataUrl);
  const userPrompt = buildUserPrompt(turns, imagePath);
  const prompt = system
    ? `System instructions:\n${system}\n\n---\n\n${userPrompt}`
    : userPrompt;

  // Pass the prompt on stdin so shells / Windows argument quoting cannot mangle it.
  // codex treats a trailing `-` as "read prompt from stdin".
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--json',
    '--sandbox', 'read-only'
  ];
  if (model) args.push('-m', model);
  if (imagePath) args.push('-i', imagePath);
  args.push('-');

  let full = '';
  let emitted = 0;
  try {
    await runProcess(bin, args, {
      stdinText: prompt,
      onActivity,
      onStdoutLine: (line) => {
        let evt;
        try { evt = JSON.parse(line); } catch { return; }
        // Final assistant text
        if (evt.type === 'item.completed' && evt.item && evt.item.type === 'agent_message') {
          const text = String(evt.item.text || '');
          if (!text) return;
          // Stream only the new suffix if messages grow (usually one shot)
          const add = text.startsWith(full) ? text.slice(full.length) : text;
          full = text;
          if (add && onToken) {
            onToken(add);
            emitted += add.length;
          }
        }
        // Some builds stream token deltas
        if (evt.type === 'item.updated' && evt.item && evt.item.type === 'agent_message' && evt.item.text) {
          const text = String(evt.item.text || '');
          const add = text.startsWith(full) ? text.slice(full.length) : '';
          if (add) {
            full = text;
            if (onToken) {
              onToken(add);
              emitted += add.length;
            }
          }
        }
      }
    });
    const text = full.trim();
    if (!text) throw new Error('Codex CLI returned an empty response. Run `codex login` and try again.');
    if (!emitted && onToken) onToken(text);
    return text;
  } finally {
    if (imagePath) try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
  }
}

/**
 * Grok Build CLI one-shot — uses `grok -p` with the logged-in session.
 * Prefer the API path (provider "grok") for streaming + screenshots; this is a
 * fallback pure-CLI route when the user picks "Grok CLI".
 */
async function streamGrokCli({ model, system, turns, imageDataUrl, onToken, onActivity }) {
  const bin = whichCmd('grok');
  const imagePath = writeTempImage(imageDataUrl);
  const userPrompt = buildUserPrompt(turns, imagePath);
  const prompt = system
    ? `${system}\n\n---\n\n${userPrompt}`
    : userPrompt;

  // Prefer stdin so long interview context is not truncated by argv limits.
  const args = ['-p', '--output-format', 'plain'];
  if (model) args.push('-m', model);

  let full = '';
  try {
    const { stdout } = await runProcess(bin, args, {
      stdinText: prompt,
      onActivity,
      timeoutMs: 300000,
      onStdoutChunk: (chunk) => {
        full += chunk;
        if (onToken) onToken(chunk);
      }
    });
    const text = (full || stdout || '').trim();
    if (!text) throw new Error('Grok CLI returned an empty response. Run `grok login` and try again.');
    if (!full && onToken) onToken(text);
    return text;
  } finally {
    if (imagePath) try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
  }
}

async function streamCliProvider(provider, params) {
  if (provider === 'claude-cli') return streamClaudeCli(params);
  if (provider === 'codex-cli') return streamCodexCli(params);
  if (provider === 'grok-cli') return streamGrokCli(params);
  throw new Error('unknown CLI provider: ' + provider);
}

function cliProviderReady(provider) {
  if (!isCliProvider(provider)) return { ok: false, error: 'not a CLI provider' };
  const name = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : 'grok';
  const bin = whichCmd(name);
  if (bin === name) {
    // Still might be on PATH via shell; spawn will fail clearly if missing
    return { ok: true, bin, note: 'resolved via PATH' };
  }
  if (!fs.existsSync(bin)) {
    return {
      ok: false,
      error: `${name} CLI not found. Install it and make sure \`${name}\` is on your PATH.`
    };
  }
  return { ok: true, bin };
}

module.exports = {
  CLI_PROVIDERS,
  isCliProvider,
  streamCliProvider,
  streamClaudeCli,
  streamCodexCli,
  streamGrokCli,
  cliProviderReady,
  whichCmd
};
