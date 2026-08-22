// Durable JSON settings persistence for cue-data.json.
//
// Why this exists as its own module: the previous store wrote the settings
// file with a bare fs.writeFileSync (which truncates the destination before
// writing) and swallowed every error. A crash or power loss mid-write left
// corrupt JSON, and load() then silently reset EVERY saved API key and
// interview-prep field to blank on the next launch — unrecoverable, because
// the next save overwrote whatever remained. It also could not be unit
// tested at all, because it called app.getPath('userData') at require time,
// which throws outside Electron.
//
// The store therefore takes the userData directory lazily (factory pattern,
// like WhisperModelManager's injected userDataPath) and writes atomically:
//   1. serialize to FILE.tmp          (a crash here leaves the real file intact)
//   2. copy the previous FILE to FILE.bak   (best-effort, one generation)
//   3. rename TMP over FILE           (atomic replace, Windows-safe in Node;
//                                      falls back to an in-place write when
//                                      another process briefly holds FILE —
//                                      e.g. antivirus on Windows)
// On load, a corrupt or truncated FILE is recovered from FILE.bak before
// falling back to defaults, and every failure is logged instead of ignored.
const fs = require('fs');
const path = require('path');

const MAX_AI_RULES_CHARS = 2000;

function createSettingsStore(resolveUserDataDir, {
  label = 'cue-data.json',
  afterMerge,
} = {}) {
  let filePath = null;

  // Paths are resolved on first use rather than at creation so that merely
  // requiring this module never needs Electron (tests run on plain Node).
  function p(file) {
    if (!filePath) filePath = path.join(resolveUserDataDir(), file);
    return filePath;
  }
  const mainPath = () => p(label);
  const tmpPath = () => mainPath() + '.tmp';
  const bakPath = () => mainPath() + '.bak';

  let data = null;
  let lastError = null;

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

  function parseJson(candidate) {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  }

  function load() {
    if (data) return data;

    let parsed = null;
    let mainMissing = false;
    try {
      parsed = parseJson(mainPath());
    } catch (e) {
      mainMissing = e && e.code === 'ENOENT';
      if (!mainMissing) {
        // Corrupt/truncated/unreadable is worth saying out loud; a missing
        // file on first run is normal and stays quiet.
        console.error('[cue] cannot read ' + mainPath() + ':', e && e.message);
      }
    }
    if (parsed !== null) {
      data = deepMerge(DEFAULTS, parsed);
      return data;
    }

    // The main file is gone or unusable. A stale .bak from the previous good
    // save is strictly better than blanking every key the user has stored.
    try {
      parsed = parseJson(bakPath());
      console.error('[cue] ' + label + ' was lost or corrupt — recovered settings from backup');
      data = deepMerge(DEFAULTS, parsed);
      persist(); // best-effort heal so the corruption doesn't linger
      return data;
    } catch (bakErr) {
      if (!(bakErr && bakErr.code === 'ENOENT')) {
        console.error('[cue] cannot read backup ' + bakPath() + ':', bakErr && bakErr.message);
      }
    }

    if (!mainMissing) {
      console.error('[cue] no usable backup for ' + label + '; starting from defaults');
    }
    data = deepMerge(DEFAULTS, {});
    return data;
  }

  // Serialize → snapshot the previous good state → atomic replace. Never
  // throws: callers rely on setSettings not rejecting (the IPC handler can
  // surface failures separately via lastSaveError()).
  function persist() {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath(), json);
    try {
      if (fs.existsSync(mainPath())) fs.copyFileSync(mainPath(), bakPath());
    } catch (_) { /* backup is best-effort; never block the save */ }
    try {
      fs.renameSync(tmpPath(), mainPath());
    } catch (_) {
      // Windows: antivirus/indexers can hold the target open for a moment,
      // making rename fail with EPERM. An in-place write still beats losing
      // the user's keys over a transient lock.
      fs.writeFileSync(mainPath(), json);
      try { fs.unlinkSync(tmpPath()); } catch (_) {}
    }
  }

  function save() {
    try {
      persist();
      lastError = null;
      return true;
    } catch (e) {
      lastError = e;
      console.error('[cue] failed to save ' + label + ':', e && e.message);
      return false;
    }
  }

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

  return {
    MAX_AI_RULES_CHARS,
    getSettings() { return load(); },
    setSettings(patch) {
      load();
      data = deepMerge(data, patch || {});
      // Applied on writes only — matches the original store's behavior, where
      // values loaded from disk were never re-normalized.
      if (afterMerge) data = afterMerge(data);
      save();
      return data;
    },
    /** Null when the last save succeeded; the error otherwise. */
    lastSaveError() { return lastError; },
  };
}

module.exports = { createSettingsStore, MAX_AI_RULES_CHARS };
