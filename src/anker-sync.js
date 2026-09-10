// Anker upload-only bridge. No capture, provider keys, screenshots or live stream.
const fs = require('node:fs');
const crypto = require('node:crypto');

const ORIGIN = 'https://www.an-ker.de';
const MAX_TRANSCRIPT = 60000;

function createAnkerSync({ file, safeStorage, fetchImpl = fetch, now = Date.now }) {
  let state = null;
  let busy = false;
  function secure() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Unlock your OS credential store to connect Anker. Insecure credential storage is disabled.');
    }
  }
  function load() {
    secure();
    if (state) return state;
    if (!fs.existsSync(file)) return (state = { connection: null, queue: [] });
    try {
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      if (!Array.isArray(parsed.queue)) throw new Error('Invalid queue');
      return (state = parsed);
    } catch { throw new Error('Could not unlock the Anker queue. No records were replaced. Restore access to your OS credential store.'); }
  }
  function persist(next) {
    secure();
    const temp = `${file}.tmp`;
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    state = next;
  }
  function publicState() {
    const s = load();
    return {
      connection: s.connection ? { ...s.connection.scope } : null,
      queue: s.queue.map(({ payload, ...item }) => ({ ...item, title: payload.title, characters: payload.transcript.length })),
      busy,
    };
  }
  async function exclusive(fn) {
    if (busy) throw new Error('Another Anker operation is running. Please wait.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function api(token, body) {
    const response = await fetchImpl(`${ORIGIN}/api/calls/sync`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Reconnect Anker: this key expired, was revoked or lost workspace access.' : response.status === 409 ? 'Import conflict. Review this call in Anker; the server did not overwrite it.' : `Anker upload failed (${response.status}). Your queued transcript is retained.`);
      error.status = response.status;
      throw error;
    }
    return json;
  }
  return {
    status: publicState,
    connect(token) {
      return exclusive(async () => {
        if (!/^anker_call_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Paste an Anker Call Intelligence connection key.');
        const current = load();
        const result = await api(token);
        if (!result.scope?.userId || !result.scope?.orgId || !['founder', 'vc', 'lp'].includes(result.scope.persona) || !result.permissions?.includes('calls:upload')) throw new Error('Anker returned an invalid connection response.');
        if (current.queue.some(item => item.userId !== result.scope.userId || item.orgId !== result.scope.orgId)) {
          throw new Error('Queued calls belong to a different account or workspace. Upload or remove them before switching.');
        }
        persist({ ...current, connection: { token, scope: result.scope } });
        return publicState();
      });
    },
    disconnect() {
      if (busy) throw new Error('Wait for the current Anker operation to finish.');
      persist({ ...load(), connection: null });
      return publicState();
    },
    enqueue({ title, transcript, consent, externalId }) {
      if (busy) throw new Error('Wait for the current Anker operation to finish.');
      const current = load();
      if (!current.connection) throw new Error('Connect an Anker workspace first.');
      if (consent !== true) throw new Error('Confirm permission to upload this transcript.');
      if (typeof transcript !== 'string' || transcript.trim().length < 20 || transcript.length > MAX_TRANSCRIPT) throw new Error('The transcript must contain 20–60,000 characters.');
      if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Add a call title of up to 200 characters.');
      if (!/^[0-9a-f-]{36}$/i.test(externalId)) throw new Error('Invalid capture identifier.');
      const { userId, orgId } = current.connection.scope;
      if (current.queue.some(item => item.payload.externalId === externalId && item.userId === userId && item.orgId === orgId)) throw new Error('This capture is already in the queue.');
      if (current.queue.length >= 50) throw new Error('Queue is full. Upload or remove a queued call first.');
      const item = { id: crypto.randomUUID(), userId, orgId, status: 'pending', attempts: 0, retryAt: 0,
        payload: { title: title.trim(), transcript: transcript.trim(), consent: true, externalId }, createdAt: now() };
      persist({ ...current, queue: [...current.queue, item] });
      return publicState();
    },
    remove(id) {
      if (busy) throw new Error('Wait for the current Anker operation to finish.');
      const s = load();
      persist({ ...s, queue: s.queue.filter(item => item.id !== id) });
      return publicState();
    },
    upload() {
      return exclusive(async () => {
        let s = load();
        if (!s.connection) throw new Error('Connect Anker before uploading queued calls.');
        for (const item of [...s.queue]) {
          if (item.userId !== s.connection.scope.userId || item.orgId !== s.connection.scope.orgId) throw new Error('Account or workspace mismatch. Upload stopped.');
          if (item.retryAt > now() || item.status === 'blocked') continue;
          try {
            const result = await api(s.connection.token, item.payload);
            if (!result.call?.id) throw new Error('Anker did not confirm the saved call.');
            // If persisting fails after the response, the same externalId is retried safely.
            persist({ ...s, queue: s.queue.filter(q => q.id !== item.id) });
            s = load();
          } catch (error) {
            const attempts = item.attempts + 1;
            const blocked = [400, 409, 410, 413].includes(error.status);
            const message = error.status ? error.message : 'Connection interrupted. Transcript retained; retry shortly.';
            persist({ ...s, queue: s.queue.map(q => q.id === item.id ? { ...q, attempts, status: blocked ? 'blocked' : 'retry', error: message, retryAt: now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)) } : q) });
            throw new Error(message);
          }
        }
        return publicState();
      });
    },
  };
}
module.exports = { createAnkerSync, ORIGIN, MAX_TRANSCRIPT };
