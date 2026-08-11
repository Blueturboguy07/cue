// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

// Test seam: a temp data file keeps tests from touching the real user data.
const FILE = process.env.CUE_DATA_FILE || path.join(app.getPath('userData'), 'cue-data.json');

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;

// Schema versioning: cue-data.json is upgraded through MIGRATIONS when the on-disk
// version is older than the code's. When a setting shape changes, bump this and add
// a migration for the previous version — never mutate DEFAULTS silently, or stored
// data drifts (the exact bug class the settings schema table fixes).
const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  // 0 -> 1: first versioned release; no shape changes yet — defaults fill the gaps.
  0: (data) => data
};

const DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  appMode: '',
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '' , azure: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  resumeFiles: [],
  jdFiles: [],
  // Tab 3: Interview Prep
  starStories: '',
  whyCompany: '',
  whyLeaving: '',
  workStyle: '',
  // Tab 4: Q&A
  salaryTarget: '',
  questionsToAsk: '',
  autoAnswer: false,
  // Tab 5: Style
  aiRules: '',
  // Work Mode context
  workPersona: 'participant',
  workContext: '',
  projectNotes: '',
  projectNotesFiles: [],
  meetingNotesContext: '',
  teamRoster: '',
  managerNotes: '',
  keyStakeholders: '',
  persistTranscripts: false,
  enableSentimentDetection: false,
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

function load() {
  if (data) return data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { raw = null; }
  let version = raw && typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version < SCHEMA_VERSION) {
    for (let v = version; v < SCHEMA_VERSION; v++) {
      const migrate = MIGRATIONS[v];
      if (migrate) raw = migrate(raw || {});
    }
    data = deepMerge(DEFAULTS, raw || {});
    data.schemaVersion = SCHEMA_VERSION;
  } else {
    data = deepMerge(DEFAULTS, raw || {});
  }
  return data;
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

module.exports = {
  MAX_AI_RULES_CHARS,
  SCHEMA_VERSION,
  MIGRATIONS,
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    data = nextSettings;
    save();
    return data;
  }
};
