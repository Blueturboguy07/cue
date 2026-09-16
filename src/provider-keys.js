// Encrypted at-rest storage for AI-provider API keys.
//
// These were inherited from the interview-assistant lineage and written in
// plaintext into cue-data.json, alongside window positions and prompt text. A
// settings file is world-readable to anything running as the user and ends up
// in backups and support bundles, so provider credentials do not belong there.
//
// Same posture as src/anker-sync.js: Electron safeStorage (OS keychain /
// libsecret / DPAPI), atomic 0600 write, and a refusal to fall back to the
// `basic_text` backend, which "encrypts" with a well-known key and is no better
// than plaintext.
//
// safeStorage and the file path are injected so this is testable without Electron.
const fs = require('node:fs');

function createProviderKeys({ file, safeStorage }) {
  let cache = null;

  /** True when the OS can really protect the file. */
  function available() {
    try {
      return !!safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  function requireSecure() {
    if (!available()) {
      throw new Error('Unlock your OS credential store to save provider keys. Insecure credential storage is disabled.');
    }
  }

  /**
   * Stored keys, or {} when nothing has been saved yet.
   * Returns {} rather than throwing when the store is locked, so the app still
   * opens — the keys are simply absent until it is unlocked.
   */
  function load() {
    if (cache) return cache;
    if (!fs.existsSync(file) || !available()) return (cache = {});
    try {
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      return (cache = parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      // A corrupt or foreign-keyed file must not silently look like "no keys
      // configured", which would send the user to re-enter credentials while
      // the old ciphertext sits there. Surface it instead.
      throw new Error('Could not unlock your saved provider keys. Nothing was overwritten. Restore access to your OS credential store.');
    }
  }

  /** Replace the stored set. Refuses to write anything the OS cannot protect. */
  function save(keys) {
    requireSecure();
    const next = {};
    for (const [k, v] of Object.entries(keys || {})) {
      if (typeof v === 'string' && v.trim()) next[k] = v.trim();
    }
    const temp = `${file}.tmp`;
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    cache = next;
    return next;
  }

  return { available, load, save };
}

module.exports = { createProviderKeys };
