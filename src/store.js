// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// The durability mechanics live in ./settings-store-core so they can be unit
// tested without Electron; this file only wires it to cue's userData path and
// keeps the public surface (getSettings/setSettings/MAX_AI_RULES_CHARS).
const path = require('path');
const { app } = require('electron');
const { createSettingsStore, MAX_AI_RULES_CHARS } = require('./settings-store-core');
const { normalizeBaseUrl } = require('./openai-compatible');

const store = createSettingsStore(
  () => app.getPath('userData'),
  {
    // Base URLs are normalized when written (not when read) — same timing as
    // the original implementation.
    afterMerge(settings) {
      settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
      return settings;
    },
  }
);

module.exports = {
  MAX_AI_RULES_CHARS,
  getSettings() { return store.getSettings(); },
  setSettings(patch) { return store.setSettings(patch); },
  /** Null when the last save succeeded; the error otherwise. */
  lastSaveError() { return store.lastSaveError(); },
};
