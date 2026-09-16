// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// Provider API keys are the exception: they live encrypted in provider-keys.enc
// through the OS credential store, never in cue-data.json. getSettings() still
// returns them under `apiKeys` and setSettings() still accepts them there, so
// every caller is unchanged — only the location on disk differs.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');
const { createProviderKeys } = require('./provider-keys');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');
const KEYS_FILE = path.join(app.getPath('userData'), 'provider-keys.enc');

const providerKeys = createProviderKeys({ file: KEYS_FILE, safeStorage });

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '' , azure: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  // Window position
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

let data = null;
// Set when saved keys exist but the OS store could not be unlocked this session.
let keyStoreError = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if (k === 'aiRules' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

/**
 * One-time move of plaintext keys out of cue-data.json.
 *
 * Ordering matters: the encrypted copy is written and confirmed BEFORE the
 * plaintext is scrubbed, so an interruption or a locked credential store can
 * never lose the user's keys — the worst case is that the migration runs again
 * next launch. When the OS store is unavailable the keys are left exactly where
 * they are rather than deleted; there is nowhere safer to put them yet.
 */
function migratePlaintextKeys(fileKeys) {
  const present = Object.entries(fileKeys || {}).filter(([, v]) => typeof v === 'string' && v.trim());
  if (!present.length || !providerKeys.available()) return false;
  try {
    providerKeys.save({ ...providerKeys.load(), ...Object.fromEntries(present) });
    return true;
  } catch { return false; }
}

function load() {
  if (data) return data;
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { onDisk = {}; }

  const migrated = migratePlaintextKeys(onDisk.apiKeys);
  data = deepMerge(DEFAULTS, onDisk);

  // The encrypted store is authoritative; anything still in the JSON file is
  // legacy and is dropped from memory so it cannot be written back out.
  let stored = {};
  try { stored = providerKeys.load(); }
  catch (e) { keyStoreError = e.message; }
  data.apiKeys = deepMerge(DEFAULTS.apiKeys, stored);

  // Rewrite without the plaintext block only once the ciphertext is durable.
  if (migrated) save();
  return data;
}

/** Persist non-secret settings. apiKeys are deliberately never written here. */
function save() {
  try {
    const { apiKeys, ...rest } = data;
    fs.writeFileSync(FILE, JSON.stringify(rest, null, 2));
  } catch (e) { /* ignore */ }
}

module.exports = {
  MAX_AI_RULES_CHARS,
  getSettings() { return load(); },
  /** Null unless saved keys exist but could not be unlocked this session. */
  getKeyStoreError() { load(); return keyStoreError; },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);

    // Route secrets to the encrypted store. A failure here must surface rather
    // than silently drop the key or fall back to writing it in the clear.
    if (patch && patch.apiKeys) {
      providerKeys.save(deepMerge(providerKeys.load(), patch.apiKeys));
      keyStoreError = null;
    }

    data = nextSettings;
    save();
    return data;
  }
};
