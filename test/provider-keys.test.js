const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createProviderKeys } = require('../src/provider-keys');

// Test cipher only: production uses Electron safeStorage and rejects basic_text.
const key = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: s => {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([iv, c.update(s), c.final()]);
  },
  decryptString: b => {
    const c = crypto.createDecipheriv('aes-256-cbc', key, b.subarray(0, 16));
    return Buffer.concat([c.update(b.subarray(16)), c.final()]).toString();
  },
};

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')), 'provider-keys.enc');
}

test('keys round-trip and are not readable as plaintext on disk', () => {
  const file = tmpFile();
  const store = createProviderKeys({ file, safeStorage });
  store.save({ openai: 'sk-secret-value', gemini: 'AIza-secret' });

  const raw = fs.readFileSync(file);
  assert.ok(!raw.toString('utf8').includes('sk-secret-value'), 'secret must not appear in the file');
  assert.ok(!raw.toString('utf8').includes('AIza-secret'));

  const reopened = createProviderKeys({ file, safeStorage });
  assert.deepStrictEqual(reopened.load(), { openai: 'sk-secret-value', gemini: 'AIza-secret' });
});

test('blank values are dropped rather than stored', () => {
  const file = tmpFile();
  const store = createProviderKeys({ file, safeStorage });
  store.save({ openai: 'sk-live', anthropic: '', groq: '   ' });
  assert.deepStrictEqual(store.load(), { openai: 'sk-live' });
});

test('file is written 0600', () => {
  const file = tmpFile();
  createProviderKeys({ file, safeStorage }).save({ openai: 'sk-live' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('refuses to write when the OS store is unavailable', () => {
  const file = tmpFile();
  const locked = createProviderKeys({ file, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
  assert.throws(() => locked.save({ openai: 'sk-live' }), /Insecure credential storage is disabled/);
  assert.ok(!fs.existsSync(file), 'nothing may be written when it cannot be protected');
});

test('refuses the basic_text backend, which is not real encryption', () => {
  const file = tmpFile();
  const weak = createProviderKeys({ file, safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' } });
  assert.strictEqual(weak.available(), false);
  assert.throws(() => weak.save({ openai: 'sk-live' }), /Insecure credential storage is disabled/);
});

test('an unreadable store surfaces rather than looking empty', () => {
  const file = tmpFile();
  createProviderKeys({ file, safeStorage }).save({ openai: 'sk-live' });
  // Same file, different key — as if the OS credential changed.
  const otherKey = crypto.randomBytes(32);
  const foreign = createProviderKeys({
    file,
    safeStorage: {
      ...safeStorage,
      decryptString: b => {
        const c = crypto.createDecipheriv('aes-256-cbc', otherKey, b.subarray(0, 16));
        return Buffer.concat([c.update(b.subarray(16)), c.final()]).toString();
      },
    },
  });
  // Reporting {} here would send the user to re-enter keys while the old
  // ciphertext silently remains.
  assert.throws(() => foreign.load(), /Could not unlock your saved provider keys/);
});

test('missing file reads as no keys configured', () => {
  const store = createProviderKeys({ file: tmpFile(), safeStorage });
  assert.deepStrictEqual(store.load(), {});
});
