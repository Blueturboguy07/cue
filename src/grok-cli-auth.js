// Resolve xAI / Grok credentials for cue.
// Priority:
//   1. Explicit key passed from Settings (apiKeys.grok)
//   2. XAI_API_KEY or GROK_API_KEY environment variable
//   3. Grok CLI OAuth session at ~/.grok/auth.json (from `grok login`)
//
// The CLI session is the same one powering `grok` interactive / agent mode,
// so cue can reuse an existing Grok CLI login without a separate API key.

const fs = require('fs');
const os = require('os');
const path = require('path');

const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_STT_URL = 'https://api.x.ai/v1/stt';
const XAI_STT_WS_URL = 'wss://api.x.ai/v1/stt';

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function authFileCandidates() {
  const envPath = process.env.GROK_AUTH_FILE || process.env.GROK_AUTH_PATH;
  const list = [];
  if (envPath) list.push(expandHome(envPath));
  list.push(path.join(os.homedir(), '.grok', 'auth.json'));
  // Windows occasionally uses USERPROFILE vs HOME mismatch
  if (process.env.USERPROFILE) {
    list.push(path.join(process.env.USERPROFILE, '.grok', 'auth.json'));
  }
  return [...new Set(list)];
}

function readCliAuthEntry() {
  for (const file of authFileCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      // auth.json is a map of "issuer::userId" -> session objects
      const entries = Object.values(raw).filter((v) => v && typeof v === 'object' && v.key);
      if (!entries.length) continue;
      // Prefer a non-expired token when expires_at is present
      const now = Date.now();
      const fresh = entries.find((e) => {
        if (!e.expires_at) return true;
        const exp = Date.parse(e.expires_at);
        return !Number.isFinite(exp) || exp > now + 30_000;
      });
      const chosen = fresh || entries[0];
      return {
        source: 'grok-cli',
        file,
        key: String(chosen.key || '').trim(),
        email: chosen.email || null,
        expiresAt: chosen.expires_at || null
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Resolve a bearer token for api.x.ai.
 * @param {string} [explicitKey] optional Settings key
 * @returns {{ key: string, source: 'settings'|'env'|'grok-cli', email?: string|null, expiresAt?: string|null } | null}
 */
function resolveGrokCredentials(explicitKey) {
  const fromSettings = String(explicitKey || '').trim();
  if (fromSettings) {
    return { key: fromSettings, source: 'settings', email: null, expiresAt: null };
  }

  const fromEnv = String(process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim();
  if (fromEnv) {
    return { key: fromEnv, source: 'env', email: null, expiresAt: null };
  }

  const cli = readCliAuthEntry();
  if (cli && cli.key) return cli;
  return null;
}

function resolveGrokApiKey(explicitKey) {
  const creds = resolveGrokCredentials(explicitKey);
  return creds ? creds.key : '';
}

function describeGrokAuth(explicitKey) {
  const creds = resolveGrokCredentials(explicitKey);
  if (!creds) return { available: false, source: null, label: 'not signed in' };
  if (creds.source === 'settings') return { available: true, source: 'settings', label: 'API key in Settings' };
  if (creds.source === 'env') return { available: true, source: 'env', label: 'XAI_API_KEY env' };
  const who = creds.email ? ` (${creds.email})` : '';
  return { available: true, source: 'grok-cli', label: `Grok CLI login${who}` };
}

module.exports = {
  XAI_BASE_URL,
  XAI_STT_URL,
  XAI_STT_WS_URL,
  resolveGrokCredentials,
  resolveGrokApiKey,
  describeGrokAuth,
  readCliAuthEntry
};
