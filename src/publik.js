// publik.js — Sign in with publik, usage counting, and publik API as one provider option.
// The publik module of https://publikhq.com/sdk/publik.ts.md with the TypeScript types removed:
// this app's main process is plain JavaScript. The words of the gate, the endpoints, the timers,
// the self-test and the usage counting are the page's, unchanged.
// At app start, before any screen of your own: `const gate = await ensureSignedIn(ui)`. It
//   1. loads or provisions this computer's publik key (POST /api/v1/installs);
//   2. shows Sign in with publik until GET /api/v1/wallet says "claimed" (no other way past it);
//   3. when USES_AI: asks once how the app pays for AI and stores the answer (setChoice() changes it);
//   4. starts usage counting: app_opened now, active_session every 30 minutes (POST /api/v1/telemetry).
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { arch, homedir, hostname, platform } = require("node:os");
const { dirname, join } = require("node:path");
const { createInterface } = require("node:readline/promises");

const MODULE_DIR = __dirname;

const APP_SLUG = "cue";
/** The version of the nearest package.json: the one the release tooling bumps. */
const APP_VERSION = packageVersion();
/** false: the app calls no model. It still signs in and counts users; it skips the plan screen. */
const USES_AI = true;
const ORIGIN = process.env.PUBLIK_ORIGIN || "https://publikhq.com"; // PUBLIK_ORIGIN: tests only
const DEFAULT_BASE_URL = `${ORIGIN}/api/v1`;
/** Ask for a tier, never a vendor model name. */
const MODELS = { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" };
const POLL_MS = 3_000, POLL_LIMIT_MS = 10 * 60_000;
const OS = { darwin: "macos", win32: "windows", linux: "linux" }[platform()];

/** Walks up from this module's folder; `found(dir)` returns a value or null. */
function nearest(found) {
  for (let dir = MODULE_DIR; ; dir = dirname(dir)) {
    const v = found(dir);
    if (v) return v;
    if (dirname(dir) === dir) return null;
  }
}

function packageVersion() {
  const v = nearest((dir) => {
    try { return String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || ""); } catch { return null; }
  });
  return (v || "0.0.0").replace(/^v/i, "");
}

/** PUBLIK_APP_TOKEN, else publik-app-token.txt in this folder or a parent, else the token this app's build bakes in. */
function appToken() {
  const env = process.env.PUBLIK_APP_TOKEN?.trim();
  if (env) return env;
  const file = nearest((dir) => (existsSync(join(dir, "publik-app-token.txt")) ? readFileSync(join(dir, "publik-app-token.txt"), "utf8").trim() : null));
  return file || bakedAppToken() || "";
}
/** The token release.yml bakes into src/publik-build.json next to this module (empty in a dev checkout). */
function bakedAppToken() {
  try { const t = JSON.parse(readFileSync(join(MODULE_DIR, "publik-build.json"), "utf8")).appToken; return typeof t === "string" && t.trim() ? t.trim() : null; } catch { return null; }
}
/** True when this build can provision a key. */
function hasAppToken() { return appToken().startsWith("pat_"); }

/** ~/Library/Application Support/publik, %LOCALAPPDATA%\publik, ~/.config/publik: shared by every publik app. */
function publikDir() {
  const os = platform();
  const base = os === "darwin" ? join(homedir(), "Library", "Application Support")
    : os === "win32" ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "publik");
}
const credentialPath = () => join(publikDir(), "apps", `${APP_SLUG}.json`);

function readCredential() {
  try {
    const c = JSON.parse(readFileSync(credentialPath(), "utf8"));
    return typeof c.key === "string" && c.key.startsWith("pk_") ? c : null;
  } catch { return null; }
}
function writeCredential(c) {
  const file = credentialPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c ?? {}, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
/** The person's answer to the plan screen. Settings call it to change the answer; null asks again at the next start. */
function setChoice(choice) {
  const c = readCredential();
  if (c) writeCredential({ ...c, choice });
}

/** The key this app uses: the stored choice decides. PUBLIK_API_KEY / PUBLIK_API_BASE_URL in the environment override (development). */
function resolveProvider(userKey) {
  if (process.env.PUBLIK_API_KEY) return { kind: "publik", baseURL: process.env.PUBLIK_API_BASE_URL ?? DEFAULT_BASE_URL, apiKey: process.env.PUBLIK_API_KEY };
  const c = readCredential();
  if (c?.choice === "publik") return { kind: "publik", baseURL: c.base_url || DEFAULT_BASE_URL, apiKey: c.key };
  return userKey?.apiKey ? { kind: "own", ...userKey } : { kind: "needs_own_key" };
}

/** POST /api/v1/installs: this computer's publik key. Throws a readable message. */
async function provision() {
  const token = appToken();
  if (!token.startsWith("pat_")) throw new Error("This build has no publik app token. Ask the developer for a new build.");
  const prior = readCredential();
  let installId = prior?.install_id ?? randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${ORIGIN}/api/v1/installs`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION, os: OS ?? "linux", arch: arch(),
        device_name: hostname().slice(0, 120), install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] }),
    });
    const body = await res.json().catch(() => ({}));
    const key = body.key ?? (res.status === 200 ? prior?.key ?? null : null);
    if ((res.status === 201 || res.status === 200) && key) {
      const c = { key, base_url: body.base_url ?? DEFAULT_BASE_URL, install_id: body.install_id ?? installId, claim_url: body.claim_url ?? null, choice: prior?.choice ?? null };
      writeCredential(c); // the key reaches disk before anything else sees it
      return c;
    }
    if (res.status === 200 || body.error?.type === "install_revoked") { installId = randomUUID(); continue; }
    throw new Error(body.error?.message ?? `publik could not set up this computer (${res.status}).`);
  }
  throw new Error("publik could not set up this computer.");
}

/** GET /api/v1/wallet. 401: the key is gone (null wallet). Throws when publik is not reachable. */
async function readWallet(key) {
  const res = await fetch(`${ORIGIN}/api/v1/wallet`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || typeof b.claim_state !== "string") return { status: res.status, wallet: null, message: b.error?.message ?? null };
  return { status: res.status, message: null, wallet: { ...b, account: b.account ?? null, plan: b.plan ?? { kind: "none", label: null }, balance_micros: b.balance_micros ?? 0 } };
}

const dollars = (micros) => `$${(micros / 1_000_000).toFixed(2)}`;
/** The words of the gate. The same in every publik module. */
function gateScreen(id, w, note = null, message) {
  if (id === "unreachable") return { id, title: "Sign in with publik", body: message ?? "publik is not reachable. Check your connection.", note, buttons: [{ action: "retry", label: "Retry" }] };
  if (id === "sign_in") return { id, title: "Sign in with publik", note, buttons: [{ action: "sign_in", label: "Sign in with publik" }],
    body: "This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in." };
  const who = w?.account?.handle ? `You are signed in as @${w.account.handle}.` : "You are signed in to publik.";
  if (!w || (w.plan.kind === "none" && w.balance_micros === 0)) return { id, title: "Choose how to pay for AI", note,
    body: `${who} This app uses AI. Get a publik plan, or use your own key.`, buttons: [{ action: "get_plan", label: "Get a plan" }, { action: "own_key", label: "Use my own key" }] };
  const what = w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : `Your balance: ${dollars(w.balance_micros)}.`;
  return { id, title: "Connect your plan", note, body: `${who} ${what} Connect it to use AI in this app, or use your own key.`,
    buttons: [{ action: "connect", label: "Connect your plan" }, { action: "own_key", label: "Use my own key" }] };
}

/** Show a screen; with `until`, also poll GET /wallet every 3 s for at most 10 minutes. "done": the poll saw it; "timeout": it did not. */
async function ask(ui, screen, key, until) {
  const stop = new AbortController();
  const poll = async () => {
    for (const end = Date.now() + POLL_LIMIT_MS; Date.now() < end && !stop.signal.aborted; ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (stop.signal.aborted) break;
      const w = await readWallet(key).then((r) => r.wallet, () => null);
      if (w && until(w)) return "done";
    }
    return "timeout";
  };
  try { return await Promise.race([ui.show(screen, stop.signal), ...(until ? [poll()] : [])]); } finally { stop.abort(); }
}

/** The gate (see the top of the file). Resolves once the person is signed in; `choice` is null when USES_AI is false. */
async function ensureSignedIn(ui = terminalUI()) {
  if (process.env.PUBLIK_SELF_TEST) { console.log(await selfTest()); process.exit(0); }
  let signNote = null, signPoll = true, planNote = null, planPoll = false;
  for (;;) {
    let c, r;
    try {
      c = process.env.PUBLIK_API_KEY ? { key: process.env.PUBLIK_API_KEY, base_url: DEFAULT_BASE_URL, install_id: "", claim_url: null } : readCredential() ?? (await provision());
      r = await readWallet(c.key);
    } catch (e) {
      const offline = e instanceof TypeError || (e instanceof Error && /abort|timeout/i.test(e.name));
      await ask(ui, gateScreen("unreachable", null, null, offline ? undefined : String(e.message)));
      continue;
    }
    if (r.status === 401 && !process.env.PUBLIK_API_KEY) { writeCredential(null); continue; } // a revoked key: provision again
    const w = r.wallet;
    if (!w) { await ask(ui, gateScreen("unreachable", null, null, r.message ?? undefined)); continue; }
    if (w.claim_state !== "claimed") {
      const a = await ask(ui, gateScreen("sign_in", w, signNote), c.key, signPoll ? (x) => x.claim_state === "claimed" : undefined);
      if (a === "sign_in") { ui.openUrl(w.claim_url ?? c.claim_url ?? `${ORIGIN}/wallet`); signNote = "Waiting for you to sign in in your browser."; signPoll = true; }
      if (a === "timeout") { signNote = "No sign-in after 10 minutes. Click Sign in with publik to try again."; signPoll = false; }
      continue;
    }
    let choice = USES_AI ? readCredential()?.choice ?? null : null;
    if (USES_AI && !choice) {
      if (w.plan.kind !== "none" || w.balance_micros > 0) { planNote = null; planPoll = false; } // the plan is there: Connect your plan
      const a = await ask(ui, gateScreen("choose", w, planNote), c.key, planPoll ? (x) => x.plan.kind !== "none" || x.balance_micros > 0 : undefined);
      planNote = null; planPoll = false;
      if (a === "get_plan") { ui.openUrl(w.top_up_url); planNote = "Waiting for your plan. Finish in your browser."; planPoll = true; }
      if (a === "timeout") planNote = "No plan after 10 minutes. Click Get a plan to try again.";
      if (a !== "connect" && a !== "own_key") continue; // "done": the plan is there; the next screen is Connect your plan
      choice = a === "connect" ? "publik" : "own_key";
      setChoice(choice);
    }
    startTelemetry();
    return { key: c.key, wallet: w, choice };
  }
}

/** Builder check, run by the BUILT app: PUBLIK_SELF_TEST=1 makes ensureSignedIn() print this line and exit. */
async function selfTest() {
  try {
    const r = await readWallet((await provision()).key);
    if (!r.wallet) throw new Error(r.message ?? `GET /wallet answered ${r.status}`);
    return `publik self-test: ok ${APP_SLUG} ${APP_VERSION}`;
  } catch (e) {
    const offline = e instanceof TypeError || (e instanceof Error && /abort|timeout/i.test(e.name));
    return `publik self-test: failed: ${offline ? "publik is not reachable. Check your connection." : e instanceof Error ? e.message : String(e)}`;
  }
}

/** A terminal UI for a command-line app. An Electron app passes its own GateUI (publik-gate). */
function terminalUI() {
  return {
    async show(s, signal) {
      console.log(`\n${s.title}\n${s.body}${s.note ? `\n${s.note}` : ""}\n${s.buttons.map((b, i) => `  ${i + 1}. ${b.label}`).join("\n")}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const n = Number((await rl.question(s.buttons.length > 1 ? "Type a number and press Enter: " : "Press Enter: ", { signal })) || 1);
          if (s.buttons[n - 1]) return s.buttons[n - 1].action;
        }
      } catch { return new Promise(() => {}); } finally { rl.close(); }
    },
    openUrl(url) {
      console.log(`Open this link if your browser does not open: ${url}`);
      const [cmd, args] = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
      try { spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
    },
  };
}

// ---------- usage counting: /skills/telemetry.md sections 3-5 ----------
let timer = null, installIdOnce = null;

function usageOff() {
  const dnt = (process.env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  if (["0", "false", "off"].includes((process.env.PUBLIK_TELEMETRY ?? "").trim().toLowerCase())) return true;
  try { return JSON.parse(readFileSync(join(publikDir(), "consent.json"), "utf8")).usage === false; } catch { return false; }
}
/** One random UUID per computer account, shared by every publik app, in <publik dir>/telemetry.json (mode 0600). */
function telemetryInstallId() {
  const file = join(publikDir(), "telemetry.json");
  const saved = () => {
    try {
      const id = String(JSON.parse(readFileSync(file, "utf8")).install_id).toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null;
    } catch { return null; }
  };
  if ((installIdOnce ??= saved())) return installIdOnce;
  const fresh = randomUUID(); // if the file cannot be saved, this ID lasts for this run only
  try {
    mkdirSync(publikDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ install_id: fresh, created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }) + "\n", { flag: "wx", mode: 0o600 });
    return (installIdOnce = fresh);
  } catch { return (installIdOnce = saved() ?? fresh); } // another publik app saved its ID first
}
async function sendEvent(event) {
  const say = (result) => { if (process.env.PUBLIK_TELEMETRY_DEBUG === "1") process.stderr.write(`publik-telemetry: ${event} -> ${result}\n`); };
  try {
    if (!OS) return;
    if (usageOff()) return say("off (opt-out)");
    const key = process.env.PUBLIK_API_KEY || readCredential()?.key;
    const body = { v: 1, app: APP_SLUG, install_id: telemetryInstallId(), event, app_version: APP_VERSION.replace(/^v/i, ""), os: OS,
      ...(arch() === "arm64" || arch() === "x64" ? { arch: arch() } : {}) };
    const res = await fetch(process.env.PUBLIK_TELEMETRY_URL || `${ORIGIN}/api/v1/telemetry`, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", ...(key?.startsWith("pk_") ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    say(res.status);
  } catch (e) { say(e instanceof Error ? e.name : "error"); }
}
/** Called by ensureSignedIn(). app_opened now, active_session every 30 minutes; never throws, never blocks. */
function startTelemetry() {
  if (timer) return;
  const s = Number(process.env.PUBLIK_TELEMETRY_INTERVAL_SECONDS); // tests only
  timer = setInterval(() => void sendEvent("active_session"), (s >= 1 && s <= 86_400 ? s : 1_800) * 1000);
  timer.unref?.();
  void sendEvent("app_opened");
}

// ---------- publik API calls ----------
/** OpenAI-compatible client config: new OpenAI(clientConfig(p)). */
function clientConfig(p) { return { baseURL: p.baseURL, apiKey: p.apiKey }; }

/** A 402 renders its message plus exactly ONE link: this one. */
function topUpUrlFrom402(body) {
  const e = body?.error;
  return { message: e?.message ?? "Not enough publik API balance.", url: e?.top_up_url ?? null };
}

/** `POST /search`: web results for `q` (quote a phrase to find it exactly), one published price per search; on 402 the message and the one link. */
async function search(p, q, count = 10) {
  const res = await fetch(`${p.baseURL}/search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` }, body: JSON.stringify({ q, count }) });
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) return { results: [], ...topUpUrlFrom402(body) };
  if (!res.ok) throw new Error(body.error?.message ?? `publik API answered ${res.status}`);
  return { results: body.results ?? [] };
}

module.exports = {
  APP_SLUG, APP_VERSION, USES_AI, DEFAULT_BASE_URL, MODELS, hasAppToken, credentialPath, readCredential, setChoice,
  resolveProvider, provision, readWallet, gateScreen, ensureSignedIn, selfTest, terminalUI, startTelemetry,
  clientConfig, topUpUrlFrom402, search,
};
