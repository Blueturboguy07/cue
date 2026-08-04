"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { consentDirectory, sanitize } = require("./paths");
const { ensurePrivateDirectory } = require("./runfile");

/**
 * Consent lives in the app being asked about, and it has to be built, because
 * no operating system gives it to us: a Unix socket, a named pipe and a
 * loopback port are all invisible to TCC and to Windows' permission model.
 *
 * Two scopes, because they are not the same question:
 *
 *   read    — answer questions about what the app is doing
 *   action  — do something to the app
 *
 * Both prompt by default and denial is the fallback, so an app that forgets to
 * wire up a prompt is closed rather than open.
 */

const SCOPES = ["read", "action"];

/**
 * How sure the app is about who is calling.
 *
 * This is ordered, and the order is enforced: a grant recorded when the caller
 * was verified by code signature is *not* honoured for a caller we can only
 * take at its word. Otherwise the first Swift app to gain real verification
 * would hand its stored grants to anything that claimed the same name.
 */
const VERIFICATION_STRENGTH = {
  none: 0, // The caller told us who it is. That is all.
  token: 1, // It also knew the per-session token from the instance file.
  "code-signature": 2, // Its binary is signed by the expected team.
};

function strengthOf(verification) {
  return VERIFICATION_STRENGTH[verification] === undefined ? 0 : VERIFICATION_STRENGTH[verification];
}

class ConsentStore {
  /**
   * @param {object} options
   * @param {string} options.appId
   * @param {(request: object) => Promise<boolean>|boolean} [options.onRequest]
   *   Shows the sheet. Resolving false, throwing, or being absent all mean no.
   * @param {(state: object) => void} [options.onChange] Fires whenever a grant
   *   is added or revoked, so the app can update its "connected" indicator.
   */
  constructor({ appId, onRequest, onChange, directory, pathOptions = {} } = {}) {
    if (!appId) throw new TypeError("app-link: ConsentStore needs an appId");
    this.appId = appId;
    this.onRequest = onRequest || null;
    this.onChange = onChange || null;
    this.directory = directory || consentDirectory(pathOptions);
    this.pathOptions = pathOptions;
    this.file = path.join(this.directory, `${sanitize(appId)}.json`);
    this.state = this.#load();
    this.pending = new Map();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.callers && typeof parsed.callers === "object") {
        return { schema: 1, appId: this.appId, callers: parsed.callers };
      }
    } catch {
      /* Absent or unreadable both mean "nothing granted yet", which is the safe reading. */
    }
    return { schema: 1, appId: this.appId, callers: {} };
  }

  #save() {
    ensurePrivateDirectory(this.directory, this.pathOptions);
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    if (this.onChange) this.onChange(this.snapshot());
  }

  /**
   * A grant already on file, or null. `verification` is what we can prove about
   * the caller *right now* — a stored grant made under a stronger check does
   * not apply.
   */
  storedDecision(callerId, scope, verification = "none") {
    const record = this.state.callers[callerId] && this.state.callers[callerId][scope];
    if (!record) return null;
    if (record.decision === "granted" && strengthOf(verification) < strengthOf(record.verification)) {
      return null;
    }
    return record.decision;
  }

  /**
   * Resolve a scope for one caller: stored answer if there is one, otherwise
   * ask, otherwise no.
   *
   * Concurrent requests for the same caller and scope share one prompt. Without
   * that, a client opening two connections stacks two identical sheets.
   */
  async resolve(request) {
    const { callerId, scope, verification = "none" } = request;
    if (!SCOPES.includes(scope)) throw new Error(`app-link: unknown scope ${scope}`);

    const stored = this.storedDecision(callerId, scope, verification);
    if (stored === "granted") return true;
    if (stored === "denied") return false;

    const key = `${callerId}:${scope}`;
    if (this.pending.has(key)) return this.pending.get(key);

    const inFlight = (async () => {
      if (!this.onRequest) return false;
      try {
        return (await this.onRequest(request)) === true;
      } catch {
        return false;
      }
    })().then((granted) => {
      this.pending.delete(key);
      this.record(callerId, scope, granted ? "granted" : "denied", verification, request);
      return granted;
    });

    this.pending.set(key, inFlight);
    return inFlight;
  }

  record(callerId, scope, decision, verification = "none", request = {}) {
    if (!SCOPES.includes(scope)) throw new Error(`app-link: unknown scope ${scope}`);
    const existing = this.state.callers[callerId] || {};
    existing[scope] = {
      decision,
      verification,
      callerName: request.callerName || existing[scope]?.callerName || callerId,
      decidedAt: new Date().toISOString(),
    };
    this.state.callers[callerId] = existing;
    this.#save();
  }

  /** Undo every grant for a caller. This is what the app's settings screen calls. */
  revoke(callerId) {
    if (!this.state.callers[callerId]) return false;
    delete this.state.callers[callerId];
    this.#save();
    return true;
  }

  revokeAll() {
    this.state.callers = {};
    this.#save();
  }

  /** For rendering the settings list. */
  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

module.exports = { ConsentStore, SCOPES, VERIFICATION_STRENGTH, strengthOf };
