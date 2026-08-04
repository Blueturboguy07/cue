"use strict";

/**
 * @publik/app-link — how a catalog app answers questions from Iris.
 *
 * Zero dependencies and no build step, on purpose: this gets vendored into
 * apps that are plain CommonJS Electron projects, and a library that needs a
 * toolchain would not survive contact with nine repos.
 *
 * Read docs/iris-app-integration-plan.md in the publik repo for why the
 * protocol looks like this, and packages/app-link/README.md for how to wire it
 * into an app in about a dozen lines.
 */

const { AppLinkServer } = require("./lib/server");
const { AppLinkClient } = require("./lib/client");
const { ConsentStore, SCOPES } = require("./lib/consent");
const { EventRing, LEVELS, redact } = require("./lib/ring-buffer");
const { ERROR_CODES, PROTOCOL_VERSION } = require("./lib/protocol");
const { findInstance, listInstances, runDirectory } = require("./lib/runfile");
const { consentDirectory, publikDirectory, socketPathFor } = require("./lib/paths");

module.exports = {
  AppLinkServer,
  AppLinkClient,
  ConsentStore,
  EventRing,
  ERROR_CODES,
  LEVELS,
  PROTOCOL_VERSION,
  SCOPES,
  consentDirectory,
  findInstance,
  listInstances,
  publikDirectory,
  redact,
  runDirectory,
  socketPathFor,
};
