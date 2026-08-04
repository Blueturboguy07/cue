"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const { EventEmitter } = require("node:events");

const {
  ERROR_CODES,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  errorResponse,
  isRequest,
  successResponse,
} = require("./protocol");
const { ConsentStore } = require("./consent");
const { EventRing } = require("./ring-buffer");
const { prepareSocketPath, removeInstanceFile, writeInstanceFile } = require("./runfile");

/**
 * The server half of the app link: what a catalog app runs so Iris can ask it
 * things.
 *
 * Deliberately small. An app wires this up in a dozen lines, gets the five
 * verbs for free, and adds actions only if it wants them.
 *
 * ## What this authenticates, and what it does not
 *
 * On the Node target the trust boundary is **the user account**, not the
 * calling application. Node cannot read a Unix socket peer's credentials
 * without a native addon, so there is no way from here to check that the thing
 * on the other end is really Iris rather than another program running as the
 * same person — and the per-session token does not fix that, because any
 * process running as the user can read the instance file it came from.
 *
 * That is a smaller claim than docs/iris-app-integration-plan.md makes for the
 * Swift target, where the peer audit token gives real code-signature identity,
 * and it is why:
 *
 *   • consent is required for reads as well as actions here,
 *   • nothing is granted silently, and
 *   • the consent sheet is handed `verification: "token"`, so an app can say
 *     "a program identifying itself as Iris" rather than asserting it is Iris.
 *
 * An app that can verify its peer passes a `verifyPeer` hook and gets the
 * stronger wording, and stored grants made under the stronger check are not
 * honoured for weaker callers (see consent.js).
 */

/** Requests allowed per connection inside the window. Generous for a UI, cheap to enforce. */
const RATE_LIMIT_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 10_000;

/** A connection that says nothing for this long is closed. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** Enough for Iris plus a couple of tools; a bound is what matters, not the number. */
const DEFAULT_MAX_CONNECTIONS = 8;

class AppLinkServer extends EventEmitter {
  constructor(options = {}) {
    super();
    const { appId, appSlug, appName, appVersion } = options;
    if (!appId) throw new TypeError("app-link: AppLinkServer needs an appId");

    this.appId = appId;
    this.appSlug = appSlug || null;
    this.appName = appName || appSlug || appId;
    this.appVersion = appVersion || null;
    this.pathOptions = options.pathOptions || {};

    this.ring =
      options.ring ||
      new EventRing({ app: this.appSlug || this.appId, appVersion: this.appVersion, capacity: options.ringCapacity });

    this.consent =
      options.consent ||
      new ConsentStore({
        appId,
        onRequest: options.onConsentRequest,
        onChange: (state) => this.emit("consent-change", state),
        pathOptions: this.pathOptions,
      });

    this.stateProvider = options.stateProvider || (() => ({}));
    this.diagnosticsProvider = options.diagnosticsProvider || null;
    this.verifyPeer = options.verifyPeer || null;
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConnections = options.maxConnections || DEFAULT_MAX_CONNECTIONS;
    this.rateLimit = {
      requests: (options.rateLimit && options.rateLimit.requests) || RATE_LIMIT_REQUESTS,
      windowMs: (options.rateLimit && options.rateLimit.windowMs) || RATE_LIMIT_WINDOW_MS,
    };

    this.actions = new Map();
    this.sessions = new Set();
    this.server = null;
    this.instance = null;
    this.socketPath = null;
    this.exitHandler = null;
  }

  /**
   * Register something Iris may ask the app to *do*. Always behind the action
   * scope, which is a separate grant from reading.
   */
  action(name, { description = "", handler, inputSchema = null }) {
    if (typeof handler !== "function") throw new TypeError(`app-link: action ${name} needs a handler`);
    this.actions.set(name, { name, description, handler, inputSchema });
    return this;
  }

  /** Convenience: record an event and return it, so one call can also write the JSONL line. */
  record(event) {
    return this.ring.record(event);
  }

  async start() {
    if (this.server) return this.instance;

    this.socketPath = prepareSocketPath(this.appId, this.pathOptions);

    this.server = net.createServer((socket) => this.#accept(socket));
    this.server.on("error", (error) => this.emit("error", error));

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      // On Windows this is a named pipe. Note that libuv gives no way to pass
      // FILE_FLAG_FIRST_PIPE_INSTANCE, so a Node server cannot claim exclusive
      // ownership of the pipe name the way the plan's Windows notes assume —
      // another instance under the same account can create a second instance of
      // the same name. Same-user boundary again; MSIX packaging or a native
      // addon is the fix, and both are open questions in the plan.
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    if (process.platform !== "win32") {
      // The containing directory is already 0700, which is the control that
      // actually holds. This is the second lock on the same door.
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch {
        /* Some filesystems refuse chmod on a socket; the directory still governs. */
      }
    }

    this.instance = writeInstanceFile(
      {
        appId: this.appId,
        appSlug: this.appSlug,
        appName: this.appName,
        appVersion: this.appVersion,
        socketPath: this.socketPath,
      },
      this.pathOptions,
    );

    // A stale file is already handled by the PID liveness check on the reading
    // side, so this is tidiness rather than correctness — but a run directory
    // full of ghosts is the kind of thing that makes people distrust the whole
    // mechanism.
    this.exitHandler = () => {
      try {
        removeInstanceFile(this.appId, this.pathOptions);
      } catch {
        /* Nothing useful to do while exiting. */
      }
    };
    process.once("exit", this.exitHandler);

    this.emit("listening", this.instance);
    return this.instance;
  }

  async stop() {
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
    for (const session of Array.from(this.sessions)) session.socket.destroy();
    this.sessions.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    removeInstanceFile(this.appId, this.pathOptions);
    if (this.socketPath && process.platform !== "win32") {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* Already gone. */
      }
    }
    this.instance = null;
  }

  #accept(socket) {
    if (this.sessions.size >= this.maxConnections) {
      socket.end(encodeFrame(errorResponse(null, ERROR_CODES.RATE_LIMITED, "too many connections")));
      return;
    }

    const session = {
      socket,
      decoder: new FrameDecoder(),
      connected: false,
      caller: null,
      verification: "none",
      scopes: new Set(),
      windowStart: Date.now(),
      windowCount: 0,
    };
    this.sessions.add(session);

    socket.setEncoding("utf8");
    socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.sessions.delete(session);
      if (session.connected) this.emit("disconnected", { caller: session.caller });
    });

    socket.on("data", (chunk) => {
      const { messages, error } = session.decoder.push(chunk);
      for (const message of messages) this.#dispatch(session, message);
      if (error) {
        this.#send(session, errorResponse(null, error.code, error.message));
        socket.destroy();
      }
    });
  }

  #send(session, message) {
    if (session.socket.destroyed) return;
    session.socket.write(encodeFrame(message));
  }

  #rateLimited(session) {
    const now = Date.now();
    if (now - session.windowStart > this.rateLimit.windowMs) {
      session.windowStart = now;
      session.windowCount = 0;
    }
    session.windowCount += 1;
    return session.windowCount > this.rateLimit.requests;
  }

  async #dispatch(session, message) {
    if (!isRequest(message)) {
      this.#send(session, errorResponse(message.id, ERROR_CODES.INVALID_REQUEST, "not a JSON-RPC 2.0 request"));
      return;
    }
    if (this.#rateLimited(session)) {
      this.#send(session, errorResponse(message.id, ERROR_CODES.RATE_LIMITED, "too many requests"));
      return;
    }

    const params = message.params || {};
    try {
      if (message.method === "connect") {
        this.#send(session, successResponse(message.id, await this.#connect(session, params)));
        return;
      }
      if (!session.connected) {
        this.#send(session, errorResponse(message.id, ERROR_CODES.NOT_CONNECTED, "call connect first"));
        return;
      }
      const result = await this.#invoke(session, message.method, params);
      this.#send(session, successResponse(message.id, result));
    } catch (error) {
      const code = error && error.rpcCode ? error.rpcCode : ERROR_CODES.INTERNAL_ERROR;
      this.#send(session, errorResponse(message.id, code, error && error.message ? error.message : "internal error"));
    }
  }

  async #connect(session, params) {
    if (session.connected) throw rpcError(ERROR_CODES.INVALID_REQUEST, "already connected");

    const presented = typeof params.token === "string" ? params.token : "";
    if (!timingSafeEqualString(presented, this.instance.token)) {
      throw rpcError(ERROR_CODES.CONSENT_DENIED, "bad token");
    }
    session.verification = "token";

    const client = params.client && typeof params.client === "object" ? params.client : {};
    const callerId = typeof client.id === "string" && client.id ? client.id : "unknown";
    const callerName = typeof client.name === "string" && client.name ? client.name : callerId;

    // An app that can actually check who is calling upgrades the verification
    // here, which both changes the wording of the sheet and unlocks grants
    // recorded under the stronger check.
    if (this.verifyPeer) {
      const verified = await this.verifyPeer({ socket: session.socket, client });
      if (verified && verified.verification) session.verification = verified.verification;
      if (verified === false) throw rpcError(ERROR_CODES.CONSENT_DENIED, "peer verification failed");
    }

    session.caller = { id: callerId, name: callerName, version: client.version || null, pid: client.pid || null };
    session.connected = true;

    const requested = Array.isArray(params.scopes) ? params.scopes : ["read"];
    const granted = [];
    const denied = [];
    for (const scope of ["read", "action"]) {
      if (!requested.includes(scope)) continue;
      const ok = await this.consent.resolve({
        callerId,
        callerName,
        scope,
        verification: session.verification,
        app: { id: this.appId, name: this.appName, version: this.appVersion },
      });
      if (ok) {
        session.scopes.add(scope);
        granted.push(scope);
      } else {
        denied.push(scope);
      }
    }

    this.emit("connected", { caller: session.caller, granted, verification: session.verification });

    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instance.instanceId,
      app: { id: this.appId, slug: this.appSlug, name: this.appName, version: this.appVersion },
      granted,
      denied,
      verification: session.verification,
    };
  }

  #requireScope(session, scope) {
    if (!session.scopes.has(scope)) {
      throw rpcError(ERROR_CODES.SCOPE_DENIED, `the user has not granted ${scope} access to this app`);
    }
  }

  async #invoke(session, method, params) {
    switch (method) {
      case "describe":
        // Cheapest first, and deliberately outside the scopes: everything it
        // returns is already in the instance file, and a client needs it to
        // know what to ask for.
        return {
          protocolVersion: PROTOCOL_VERSION,
          instanceId: this.instance.instanceId,
          app: { id: this.appId, slug: this.appSlug, name: this.appName, version: this.appVersion },
          scopes: ["read", "action"],
          granted: Array.from(session.scopes),
          methods: ["describe", "get_state", "get_recent_events", "get_last_error", "capture_diagnostics", "list_actions", "invoke_action"],
          actions: this.#actionList(),
        };

      case "list_actions":
        return { actions: this.#actionList() };

      case "get_state": {
        this.#requireScope(session, "read");
        const state = await this.stateProvider();
        return { state: state === undefined ? null : state, at: new Date().toISOString() };
      }

      case "get_recent_events": {
        this.#requireScope(session, "read");
        return { events: this.ring.recent(params), sequence: this.ring.sequence };
      }

      case "get_last_error": {
        this.#requireScope(session, "read");
        return { event: this.ring.lastError() };
      }

      case "capture_diagnostics": {
        this.#requireScope(session, "read");
        return this.#diagnostics(params);
      }

      case "invoke_action": {
        this.#requireScope(session, "action");
        const name = typeof params.name === "string" ? params.name : "";
        const action = this.actions.get(name);
        if (!action) throw rpcError(ERROR_CODES.INVALID_PARAMS, `no such action: ${name}`);
        const result = await action.handler(params.arguments || {}, { caller: session.caller });
        return { result: result === undefined ? null : result };
      }

      default:
        throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `no such method: ${method}`);
    }
  }

  #actionList() {
    return Array.from(this.actions.values()).map(({ name, description, inputSchema }) => ({
      name,
      description,
      scope: "action",
      inputSchema,
    }));
  }

  async #diagnostics(params) {
    const [state, extra] = await Promise.all([
      Promise.resolve()
        .then(() => this.stateProvider())
        .catch((error) => ({ error: String(error && error.message ? error.message : error) })),
      this.diagnosticsProvider
        ? Promise.resolve()
            .then(() => this.diagnosticsProvider(params))
            .catch((error) => ({ error: String(error && error.message ? error.message : error) }))
        : Promise.resolve(null),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      app: { id: this.appId, slug: this.appSlug, name: this.appName, version: this.appVersion },
      environment: {
        os: process.platform,
        arch: process.arch,
        osVersion: require("node:os").release(),
        runtime: `node ${process.versions.node}`,
      },
      state: state === undefined ? null : state,
      lastError: this.ring.lastError(),
      // Errors and warnings only. A diagnostics bundle is read by a person or
      // fed to a patch agent, and debug chatter buries the one line that matters.
      events: this.ring.recent({ limit: params.limit || 50, minLevel: params.minLevel || "warn" }),
      extra,
    };
  }
}

function rpcError(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

/**
 * Constant-time compare that does not leak length through an early return any
 * more than it has to. Hashing both sides first makes the buffers equal length,
 * which timingSafeEqual requires.
 */
function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = { AppLinkServer, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS };
