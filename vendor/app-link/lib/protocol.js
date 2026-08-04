"use strict";

/**
 * Wire format for the publik app link.
 *
 * Newline-delimited JSON-RPC 2.0 — deliberately the same framing MCP's stdio
 * binding uses. The 2026-07-28 MCP spec says custom transports over a reliable
 * bidirectional byte stream SHOULD reuse it, because the stdio binding is
 * nothing more than newline-delimited JSON-RPC over a byte stream. So the
 * schema and the framing here are MCP's; only the transport is ours, and the
 * day Iris grows a real MCP server it re-encodes rather than re-designs.
 *
 * See docs/iris-app-integration-plan.md for why we are not embedding MCP
 * itself in nine shipped binaries.
 */

/**
 * Bumped only for a breaking change to methods or framing. Both ends report
 * theirs in `describe`, and a client that sees a major it does not know should
 * degrade rather than guess.
 */
const PROTOCOL_VERSION = "1";

/**
 * A single frame may not exceed this. Without a cap, one peer sending bytes
 * without a newline is an unbounded allocation in the other — the cheapest
 * denial of service there is against a line-framed protocol.
 */
const MAX_FRAME_BYTES = 1024 * 1024;

/** Standard JSON-RPC 2.0 codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * Implementation-defined range (-32000 to -32099 is reserved for exactly this
 * by the spec). These are the four things that actually go wrong locally.
 */
const NOT_CONNECTED = -32000;
const SCOPE_DENIED = -32001;
const CONSENT_DENIED = -32002;
const RATE_LIMITED = -32003;

const ERROR_CODES = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  NOT_CONNECTED,
  SCOPE_DENIED,
  CONSENT_DENIED,
  RATE_LIMITED,
};

/** Serialize one message as a frame, newline included. */
function encodeFrame(message) {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new TypeError("app-link: message is not serializable");
  }
  // A JSON string never contains a raw newline, so the framing cannot be
  // confused by the payload. Assert it anyway: a future change that swaps in a
  // different serializer would otherwise corrupt the stream silently.
  if (json.includes("\n")) {
    throw new Error("app-link: encoded frame contains a newline");
  }
  return json + "\n";
}

/**
 * Incremental decoder. Feed it chunks, get whole messages back.
 *
 * Errors are returned rather than thrown because the caller has to decide what
 * a bad frame means: a server hangs up on one, a client may prefer to skip it.
 */
class FrameDecoder {
  constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = "";
  }

  /**
   * @param {string|Buffer} chunk
   * @returns {{messages: object[], error: {code: number, message: string}|null}}
   */
  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        return { messages, error: { code: INVALID_REQUEST, message: "frame too large" } };
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { messages, error: { code: PARSE_ERROR, message: "invalid JSON" } };
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { messages, error: { code: INVALID_REQUEST, message: "frame is not an object" } };
      }
      messages.push(parsed);
    }

    // The tail is a partial frame. It still counts against the cap, or a peer
    // could stream forever as long as it never sent a newline.
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      return { messages, error: { code: INVALID_REQUEST, message: "frame too large" } };
    }

    return { messages, error: null };
  }
}

/** True for a JSON-RPC request we are willing to look at. */
function isRequest(message) {
  return (
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    (message.params === undefined ||
      (typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)))
  );
}

function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  ERROR_CODES,
  FrameDecoder,
  encodeFrame,
  isRequest,
  successResponse,
  errorResponse,
};
