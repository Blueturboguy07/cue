"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");

const { ERROR_CODES, FrameDecoder, encodeFrame } = require("./protocol");
const { findInstance, listInstances } = require("./runfile");

/** A local call should be instant. This is a stuck-app timeout, not a network one. */
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

/**
 * The client half — what an assistant runs to ask an app things.
 *
 * Iris on macOS is Swift and has its own implementation of this (see
 * iris-macos/leanring-buddy/AppLink*.swift). This one is for Windows Iris,
 * which is Electron, and for the tests.
 */
class AppLinkClient extends EventEmitter {
  constructor(socket, instance, identity) {
    super();
    this.socket = socket;
    this.instance = instance;
    this.identity = identity;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.nextId = 1;
    this.session = null;
    this.closed = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#failAll(new Error("app-link: connection closed")));
    socket.on("error", (error) => this.#failAll(error));
  }

  /** Everything running right now, stale entries already dropped. */
  static discover(options = {}) {
    return listInstances(options);
  }

  static find(appId, options = {}) {
    return findInstance(appId, options);
  }

  /**
   * Connect to one app.
   *
   * @param {object} instance A record from discover().
   * @param {object} options
   * @param {{id: string, name: string, version?: string}} options.client Who we
   *   claim to be. On this transport it is a claim, not a proof — see the note
   *   in server.js — and the app's consent sheet says so.
   * @param {string[]} [options.scopes]
   */
  static async open(instance, options = {}) {
    if (!instance || typeof instance.socketPath !== "string") {
      throw new TypeError("app-link: open() needs an instance record from discover()");
    }
    const identity = options.client || { id: "unknown", name: "unknown" };

    const socket = await new Promise((resolve, reject) => {
      const candidate = net.createConnection(instance.socketPath);
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error(`app-link: timed out connecting to ${instance.appId}`));
      }, options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
      candidate.once("connect", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const client = new AppLinkClient(socket, instance, identity);
    const session = await client.call(
      "connect",
      {
        token: instance.token,
        client: { ...identity, pid: process.pid },
        scopes: options.scopes || ["read"],
      },
      { timeoutMs: options.consentTimeoutMs || 120_000 }, // A human may be reading a sheet.
    );

    // The instance file said which process it belonged to. If a recycled PID
    // put someone else behind that socket, this is where it shows up rather
    // than three calls later in data that looks almost right.
    if (instance.instanceId && session.instanceId && instance.instanceId !== session.instanceId) {
      client.close();
      throw new Error(`app-link: ${instance.appId} answered with a different instance id`);
    }

    client.session = session;
    return client;
  }

  get granted() {
    return this.session ? this.session.granted : [];
  }

  call(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new Error("app-link: client is closed"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs || DEFAULT_CALL_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-link: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    });
  }

  describe() {
    return this.call("describe");
  }

  getState() {
    return this.call("get_state");
  }

  getRecentEvents(query = {}) {
    return this.call("get_recent_events", query);
  }

  getLastError() {
    return this.call("get_last_error");
  }

  captureDiagnostics(query = {}) {
    return this.call("capture_diagnostics", query, { timeoutMs: query.timeoutMs || 15_000 });
  }

  invokeAction(name, args = {}) {
    return this.call("invoke_action", { name, arguments: args }, { timeoutMs: 30_000 });
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }

  #onData(chunk) {
    const { messages, error } = this.decoder.push(chunk);
    for (const message of messages) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        this.emit("notification", message);
        continue;
      }
      this.pending.delete(message.id);
      if (message.error) {
        const rpc = new Error(message.error.message || "app-link: request failed");
        rpc.code = message.error.code;
        rpc.data = message.error.data;
        entry.reject(rpc);
      } else {
        entry.resolve(message.result);
      }
    }
    if (error) {
      this.#failAll(new Error(`app-link: ${error.message}`));
      this.socket.destroy();
    }
  }

  #failAll(error) {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

module.exports = { AppLinkClient, ERROR_CODES, DEFAULT_CALL_TIMEOUT_MS };
