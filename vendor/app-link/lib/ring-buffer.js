"use strict";

/**
 * The queryable replacement for a log file.
 *
 * docs/publik-sdk-convention.md stays exactly as it is — this holds the same
 * event shape. What changes is that the events are in memory and answerable in
 * the present tense: Iris can ask "what happened in the last thirty seconds",
 * get an answer, and then ask a follow-up. A file on disk can only ever be read
 * in full and in the past tense.
 *
 * Apps that already write the JSONL file should keep doing it. This is an
 * additional channel, not a replacement, and `record()` is happy to be the
 * same call that writes the line.
 */

const LEVELS = ["debug", "info", "warn", "error", "fatal"];
const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));

/**
 * Credentials that should never have been logged, scrubbed on the way in.
 *
 * The convention already says "never log secrets", and this does not excuse an
 * app from that. It is here because the failure mode is asymmetric: an
 * over-broad filter costs a little diagnostic detail, and a leaked key costs
 * the user money. Deliberately narrow — matching known key shapes rather than
 * anything that looks random — because redacting every long token would gut
 * the stack frames and identifiers that make an event useful at all.
 */
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function normalizeLevel(level) {
  const lowered = String(level || "info").toLowerCase();
  return LEVEL_RANK.has(lowered) ? lowered : "info";
}

class EventRing {
  /**
   * @param {object} options
   * @param {number} [options.capacity] Events kept. 256 is a few hundred KB at
   *   most and covers far more history than any one bug report needs.
   * @param {string} options.app  Catalog slug, e.g. "cue".
   * @param {string} options.appVersion
   */
  constructor({ capacity = 256, app, appVersion, os: osName, arch } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("app-link: capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.app = app || null;
    this.appVersion = appVersion || null;
    this.os = osName || process.platform;
    this.arch = arch || process.arch;
    this.events = [];
    this.sequence = 0;
  }

  /**
   * Record one event. Returns the stored copy, so a caller that also writes the
   * JSONL line can serialize exactly what was kept — including the redaction.
   */
  record(event = {}) {
    const stored = {
      seq: ++this.sequence,
      ts: event.ts || new Date().toISOString(),
      level: normalizeLevel(event.level),
      app: event.app || this.app,
      app_version: event.app_version || this.appVersion,
      os: event.os || this.os,
      arch: event.arch || this.arch,
      msg: redact(event.msg == null ? "" : String(event.msg)),
    };

    // Optional fields from the convention. `frame` earns its place: it is what
    // separates two unrelated failures that happen to share wording.
    if (event.event != null) stored.event = String(event.event);
    if (event.code != null) stored.code = String(event.code);
    if (event.frame != null) stored.frame = redact(String(event.frame));
    if (event.commit != null) stored.commit = String(event.commit);
    if (event.context && typeof event.context === "object") {
      stored.context = JSON.parse(redact(JSON.stringify(event.context)));
    }

    this.events.push(stored);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return stored;
  }

  /**
   * @param {object} [query]
   * @param {number} [query.limit]
   * @param {string} [query.minLevel] Only this level and above.
   * @param {string} [query.since] ISO timestamp, exclusive.
   * @param {number} [query.afterSeq] Everything newer than this sequence
   *   number — how a client polls without re-reading what it already has.
   */
  recent(query = {}) {
    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), this.capacity) : 50;
    const floor = query.minLevel ? LEVEL_RANK.get(normalizeLevel(query.minLevel)) : 0;
    const since = query.since ? Date.parse(query.since) : null;
    const afterSeq = Number.isInteger(query.afterSeq) ? query.afterSeq : null;

    const matches = this.events.filter((event) => {
      if (LEVEL_RANK.get(event.level) < floor) return false;
      if (afterSeq !== null && event.seq <= afterSeq) return false;
      if (since !== null && !Number.isNaN(since) && Date.parse(event.ts) <= since) return false;
      return true;
    });

    // Newest last, so a caller can print them in order, but truncated from the
    // front — when there is too much, the recent end is the useful end.
    return matches.slice(-limit);
  }

  /** The most recent `error` or `fatal`, which is what a bug report is about. */
  lastError() {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event.level === "error" || event.level === "fatal") return event;
    }
    return null;
  }

  clear() {
    this.events = [];
  }
}

module.exports = { EventRing, LEVELS, redact };
