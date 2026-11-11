// CI only (see .github/workflows/publik-build.yml). Not part of the app.
//
// The built-app proof of https://publikhq.com/skills/setup.md step 6: the packaged app is
// started with PUBLIK_SELF_TEST=1 against a fake publik on this machine, and must print
// exactly `publik self-test: ok <slug> <version>` and exit. The publik module prints that
// line only after POST /api/v1/installs and a real GET /api/v1/wallet answered, so a pass
// shows the gate is on the start-up path of this build. Nothing here talks to publikhq.com.
//
// usage: node publik-self-test.cjs <slug> <app executable> [--out <result.json>] [-- app arguments...]
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const argv = process.argv.slice(2);
const slug = argv.shift();
const exe = argv.shift();
let out = null;
const appArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--") appArgs.push(...argv.slice(i + 1)), (i = argv.length);
  else appArgs.push(argv[i]);
}
if (!slug || !exe) {
  console.error("usage: node publik-self-test.cjs <slug> <app executable> [--out <result.json>] [-- app arguments...]");
  process.exit(2);
}

const WANT_VERSION = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version.replace(/^v/i, "");
const WANT_LINE = `publik self-test: ok ${slug} ${WANT_VERSION}`;
const WAIT_MS = 90_000;
const KEY = "pk_live_selftest0000_00000000000000000000000000000000"; // a fake key for the fake publik of this test

const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ? "present" : "absent", body });
    const json = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "POST" && req.url === "/api/v1/installs") {
      let installId = "";
      try { installId = JSON.parse(body).install_id; } catch {}
      return json(201, { key: KEY, install_id: installId, claim_url: `http://127.0.0.1:${server.address().port}/claim/x`, claim_state: "anonymous" });
    }
    if (req.method === "GET" && req.url === "/api/v1/wallet") {
      return json(200, { claim_state: "claimed", claim_url: null, account: { handle: "ci" }, plan: { kind: "plan", label: "CI" }, balance_micros: 0, top_up_url: "", linked_at: null });
    }
    if (req.method === "POST" && req.url === "/api/v1/telemetry") { res.writeHead(204); return res.end(); }
    json(404, {});
  });
});

function stopApp(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`fake publik on ${origin}; app: ${exe}; want: "${WANT_LINE}"`);

  // A home folder of its own: the credential and the telemetry ID of this run never touch the runner's.
  const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "publik-self-test-"));
  const env = {
    ...process.env,
    PUBLIK_SELF_TEST: "1",
    PUBLIK_ORIGIN: origin,
    HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    DO_NOT_TRACK: "1",
  };
  delete env.PUBLIK_API_KEY;
  delete env.PUBLIK_APP_TOKEN; // the built app must carry its own token

  const child = spawn(exe, appArgs, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdout = "", stderr = "", exited = null;
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (err) => { exited = `could not start: ${err.message}`; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const end = Date.now() + WAIT_MS;
  while (Date.now() < end && exited === null) {
    if (stdout.includes("publik self-test:")) { await sleep(1500); break; }
    await sleep(250);
  }
  if (exited === null) { await sleep(1000); stopApp(child); await sleep(1000); }
  server.close();

  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith("publik self-test:"));
  const problems = [];
  if (lines.length !== 1) problems.push(`expected one self-test line, got ${lines.length}: ${JSON.stringify(lines)}`);
  if (lines[0] !== WANT_LINE) problems.push(`the line is ${JSON.stringify(lines[0] ?? null)}, want ${JSON.stringify(WANT_LINE)}`);
  const urls = requests.map((r) => `${r.method} ${r.url}`);
  if (!urls.includes("POST /api/v1/installs")) problems.push("no POST /api/v1/installs arrived");
  if (!urls.includes("GET /api/v1/wallet")) problems.push("no GET /api/v1/wallet arrived");
  const installs = requests.find((r) => r.url === "/api/v1/installs");
  if (installs) {
    let b = {};
    try { b = JSON.parse(installs.body); } catch { problems.push("the installs body is not JSON"); }
    if (b.app_slug !== slug) problems.push(`installs app_slug is ${b.app_slug}`);
    if (b.app_version !== WANT_VERSION) problems.push(`installs app_version is ${b.app_version}, want ${WANT_VERSION}`);
    if (!b.app_token || !String(b.app_token).startsWith("pat_")) problems.push("installs carries no pat_ app token: the build has none");
  }
  const wallet = requests.find((r) => r.url === "/api/v1/wallet");
  if (wallet && wallet.authorization !== "present") problems.push("GET /wallet carries no key");
  if (exited && typeof exited === "object" && exited.code !== 0 && exited.code !== null) problems.push(`the app exited with code ${exited.code}`);
  if ((stdout + stderr).includes(KEY)) problems.push("the key was printed");

  const result = { pass: problems.length === 0, problems, want: WANT_LINE, lines, requests: urls, exited, stderrTail: stderr.split(/\r?\n/).slice(-20) };
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log(result.pass ? `PASS  ${WANT_LINE}` : "RESULT: FAIL");
  process.exit(result.pass ? 0 : 1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => { console.error(err); process.exit(1); });
