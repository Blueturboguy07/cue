// Keep the Grok CLI warm for the lifetime of cue so the first Assist /
// listen turn is not paying a cold-start tax on the CLI, OAuth session, or
// TLS path to api.x.ai.
//
// Strategy:
//   1. Ensure `grok agent leader --no-exit-on-disconnect` is running
//      (shared, long-lived backend the CLI uses for agent work).
//   2. Pre-warm the same credentials cue uses for chat + voice STT with a
//      tiny /models (and optional chat) ping so HTTP keep-alive + token
//      validation happen before the user presses anything.
//   3. Heartbeat: restart a dead leader, re-warm credentials periodically.
//
// The leader is left running when cue quits so the next launch is also warm.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGrokCredentials, XAI_BASE_URL } = require('./grok-cli-auth');

const DEFAULT_LEADER_ARGS = [
  'agent',
  'leader',
  '--no-exit-on-disconnect',
  '--relay-on-demand',
  '--no-auto-update'
];

// How often we verify the leader is still alive.
const HEALTH_MS = 30_000;
// How often we re-touch api.x.ai so TLS / token stay hot.
const WARM_MS = 4 * 60_000;
// Don't re-spawn the leader more than once every few seconds.
const RESPAWN_COOLDOWN_MS = 5_000;

let state = {
  started: false,
  starting: false,
  leaderPid: null,
  child: null,           // ChildProcess we own (null if we adopted an existing leader)
  lastWarmAt: 0,
  lastWarmOk: false,
  lastError: null,
  lastSpawnAt: 0,
  authSource: null,
  timers: { health: null, warm: null },
  onStatus: null
};

function emit(status, detail = {}) {
  const payload = {
    status,
    leaderPid: state.leaderPid,
    lastWarmOk: state.lastWarmOk,
    lastWarmAt: state.lastWarmAt,
    authSource: state.authSource,
    error: state.lastError,
    ...detail
  };
  if (typeof state.onStatus === 'function') {
    try { state.onStatus(payload); } catch { /* ignore UI errors */ }
  }
  return payload;
}

function homeGrokDir() {
  if (process.env.USERPROFILE) return path.join(process.env.USERPROFILE, '.grok');
  return path.join(os.homedir(), '.grok');
}

function resolveGrokBinary() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) {
    return process.env.GROK_BIN;
  }
  const candidates = [
    path.join(homeGrokDir(), 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'),
    path.join(homeGrokDir(), 'bin', 'grok'),
    'grok'
  ];
  for (const c of candidates) {
    if (c === 'grok') continue;
    if (fs.existsSync(c)) return c;
  }
  return 'grok'; // rely on PATH
}

function readLeaderLockPid() {
  try {
    const lock = path.join(homeGrokDir(), 'leader.lock');
    if (!fs.existsSync(lock)) return null;
    const raw = fs.readFileSync(lock, 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still "alive"
    return !!(err && err.code === 'EPERM');
  }
}

function findExistingLeaderPid() {
  // Prefer the lock file the CLI itself writes.
  const locked = readLeaderLockPid();
  if (locked && isPidAlive(locked)) return locked;

  // Fall back to our own tracked child.
  if (state.leaderPid && isPidAlive(state.leaderPid)) return state.leaderPid;
  if (state.child && state.child.pid && isPidAlive(state.child.pid)) return state.child.pid;

  return null;
}

function spawnLeader() {
  const now = Date.now();
  if (now - state.lastSpawnAt < RESPAWN_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }

  const existing = findExistingLeaderPid();
  if (existing) {
    state.leaderPid = existing;
    state.lastError = null;
    return { ok: true, pid: existing, adopted: true };
  }

  const bin = resolveGrokBinary();
  state.lastSpawnAt = now;
  state.starting = true;

  let child;
  try {
    child = spawn(bin, DEFAULT_LEADER_ARGS, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        // Avoid interactive TUI / color noise when launched from Electron
        NO_COLOR: process.env.NO_COLOR || '1',
        GROK_AGENT: process.env.GROK_AGENT || '1'
      }
    });
  } catch (err) {
    state.starting = false;
    state.lastError = err.message || String(err);
    return { ok: false, reason: state.lastError };
  }

  // Detach fully so Electron exit does not take the leader down — next cue
  // launch reuses a warm process.
  try { child.unref(); } catch { /* ignore */ }

  state.child = child;
  state.leaderPid = child.pid || null;
  state.starting = false;
  state.lastError = null;

  child.on('error', (err) => {
    state.lastError = err.message || String(err);
    emit('leader-error', { error: state.lastError });
  });

  child.on('exit', (code, signal) => {
    if (state.leaderPid === child.pid) {
      state.leaderPid = null;
      state.child = null;
    }
    emit('leader-exit', { code, signal });
  });

  return { ok: true, pid: state.leaderPid, adopted: false, bin };
}

/**
 * Touch api.x.ai with the same credentials cue will use for chat/STT.
 * Keeps OAuth validation + TLS warm without spending a real Assist turn.
 */
async function warmApi(explicitKey) {
  const creds = resolveGrokCredentials(explicitKey);
  if (!creds || !creds.key) {
    state.lastWarmOk = false;
    state.authSource = null;
    state.lastError = 'No Grok credentials (run `grok login` or set XAI_API_KEY).';
    return { ok: false, error: state.lastError };
  }

  state.authSource = creds.source;
  const headers = {
    Authorization: `Bearer ${creds.key}`,
    'Content-Type': 'application/json'
  };

  try {
    // /models is cheap and forces the auth path the CLI shares with api.x.ai
    const modelsRes = await fetch(`${XAI_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: headers.Authorization }
    });
    if (!modelsRes.ok) {
      const body = await modelsRes.text().catch(() => '');
      throw new Error(`models ${modelsRes.status}: ${body.slice(0, 160)}`);
    }

    // Tiny non-streaming chat to warm the completions path cue actually uses.
    // max_tokens=1 keeps cost negligible.
    const chatRes = await fetch(`${XAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'grok-4.5',
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
        stream: false
      })
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => '');
      // Models OK but chat failed — still partially warm; surface soft error.
      state.lastWarmAt = Date.now();
      state.lastWarmOk = false;
      state.lastError = `chat warm ${chatRes.status}: ${body.slice(0, 160)}`;
      return { ok: false, error: state.lastError, authSource: creds.source, partial: true };
    }
    // Drain body so the connection can be reused.
    await chatRes.arrayBuffer().catch(() => {});

    state.lastWarmAt = Date.now();
    state.lastWarmOk = true;
    state.lastError = null;
    return { ok: true, authSource: creds.source };
  } catch (err) {
    state.lastWarmOk = false;
    state.lastError = err.message || String(err);
    return { ok: false, error: state.lastError, authSource: creds.source };
  }
}

function ensureLeader() {
  const existing = findExistingLeaderPid();
  if (existing) {
    state.leaderPid = existing;
    return { ok: true, pid: existing, adopted: true };
  }
  return spawnLeader();
}

async function healthTick(explicitKey) {
  const leader = ensureLeader();
  if (!leader.ok && leader.reason !== 'cooldown') {
    emit('leader-missing', { error: leader.reason || state.lastError });
  } else if (leader.ok) {
    emit('leader-ready', { pid: leader.pid, adopted: !!leader.adopted });
  }

  // Warm if never succeeded or interval elapsed
  if (!state.lastWarmOk || Date.now() - state.lastWarmAt > WARM_MS - 5_000) {
    const warm = await warmApi(explicitKey);
    emit(warm.ok ? 'warm-ok' : 'warm-fail', warm);
  }
}

/**
 * Start the Grok CLI runtime supervisor.
 * @param {object} [opts]
 * @param {string} [opts.explicitKey] Settings apiKeys.grok
 * @param {(payload: object) => void} [opts.onStatus]
 * @param {boolean} [opts.warmImmediately=true]
 */
async function startGrokCliRuntime(opts = {}) {
  if (state.started) {
    // Already running — still re-ensure leader + optional re-warm
    const leader = ensureLeader();
    if (opts.warmImmediately !== false) await warmApi(opts.explicitKey);
    return getGrokCliRuntimeStatus();
  }

  state.started = true;
  state.onStatus = opts.onStatus || null;
  emit('starting');

  const leader = ensureLeader();
  if (leader.ok) {
    emit('leader-ready', { pid: leader.pid, adopted: !!leader.adopted, bin: leader.bin });
  } else {
    emit('leader-missing', { error: leader.reason || state.lastError });
  }

  if (opts.warmImmediately !== false) {
    const warm = await warmApi(opts.explicitKey);
    emit(warm.ok ? 'warm-ok' : 'warm-fail', warm);
  }

  // Health: keep leader up
  state.timers.health = setInterval(() => {
    try {
      const result = ensureLeader();
      if (result.ok) emit('leader-ready', { pid: result.pid, adopted: !!result.adopted, tick: true });
    } catch (err) {
      state.lastError = err.message || String(err);
      emit('leader-error', { error: state.lastError });
    }
  }, HEALTH_MS);
  if (state.timers.health.unref) state.timers.health.unref();

  // Warm: re-touch API on a slower cadence
  state.timers.warm = setInterval(() => {
    warmApi(opts.explicitKey)
      .then((warm) => emit(warm.ok ? 'warm-ok' : 'warm-fail', { ...warm, tick: true }))
      .catch((err) => emit('warm-fail', { error: err.message || String(err), tick: true }));
  }, WARM_MS);
  if (state.timers.warm.unref) state.timers.warm.unref();

  return getGrokCliRuntimeStatus();
}

/**
 * Stop heartbeats only. Does NOT kill the leader — leaving it warm for the
 * next cue (or grok TUI) session is the point.
 */
function stopGrokCliRuntime({ killLeader = false } = {}) {
  if (state.timers.health) { clearInterval(state.timers.health); state.timers.health = null; }
  if (state.timers.warm) { clearInterval(state.timers.warm); state.timers.warm = null; }
  state.started = false;

  if (killLeader && state.child && state.child.pid && isPidAlive(state.child.pid)) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        });
      } else {
        process.kill(state.child.pid, 'SIGTERM');
      }
    } catch { /* ignore */ }
  }

  emit('stopped', { killLeader });
  state.onStatus = null;
  return getGrokCliRuntimeStatus();
}

function getGrokCliRuntimeStatus() {
  const pid = findExistingLeaderPid();
  if (pid) state.leaderPid = pid;
  return {
    started: state.started,
    leaderPid: state.leaderPid,
    leaderAlive: !!(state.leaderPid && isPidAlive(state.leaderPid)),
    lastWarmOk: state.lastWarmOk,
    lastWarmAt: state.lastWarmAt,
    authSource: state.authSource,
    error: state.lastError,
    binary: resolveGrokBinary()
  };
}

/** Force an immediate ensure+warm cycle (e.g. after Settings save to Grok). */
async function kickGrokCliRuntime(explicitKey) {
  const leader = ensureLeader();
  const warm = await warmApi(explicitKey);
  emit(leader.ok ? 'leader-ready' : 'leader-missing', leader);
  emit(warm.ok ? 'warm-ok' : 'warm-fail', warm);
  return getGrokCliRuntimeStatus();
}

module.exports = {
  startGrokCliRuntime,
  stopGrokCliRuntime,
  getGrokCliRuntimeStatus,
  kickGrokCliRuntime,
  ensureLeader,
  warmApi,
  resolveGrokBinary,
  findExistingLeaderPid
};
