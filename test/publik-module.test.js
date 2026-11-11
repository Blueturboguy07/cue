// The one publik module (src/publik.js) against a fake publik on this
// computer: the gate's screens in order, the stored choice, a revoked key,
// PUBLIK_SELF_TEST and DO_NOT_TRACK. Each scenario starts a child Node process
// with a HOME of its own, so the credential file and the telemetry ID never
// touch this computer's. Nothing reaches publikhq.com.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'src', 'publik.js');
const VERSION = require('../package.json').version;
const SLUG = 'cue';
const KEY = 'pk_live_gatetest';

const anonymous = { claim_state: 'anonymous', account: null, plan: { kind: 'none', label: null }, balance_micros: 0 };
const claimedEmpty = { claim_state: 'claimed', account: { handle: 'mann' }, plan: { kind: 'none', label: null }, balance_micros: 0 };
const claimedPlan = { claim_state: 'claimed', account: { handle: 'mann' }, plan: { kind: 'plan', label: 'Plus' }, balance_micros: 0 };

// The child: a GateUI that logs every screen and presses the button PRESS
// names for that title (or the first button when the screen carries no
// note), then reports the gate's answer.
const HARNESS = `
const m = require(process.env.PUBLIK_MODULE);
(async () => {
  const press = JSON.parse(process.env.PRESS || '{}');
  const limit = Number(process.env.SCREEN_LIMIT || 6);
  const seen = {};
  const ui = {
    show(s) {
      console.log('SCREEN ' + JSON.stringify({ title: s.title, body: s.body, note: s.note, buttons: s.buttons.map((b) => b.label) }));
      const n = (seen[s.title] = (seen[s.title] || 0) + 1);
      if (n > limit) process.exit(3);
      const want = press[s.title];
      if (want === 'exit') process.exit(0);
      if (want) return Promise.resolve(s.buttons.find((b) => b.label === want).action);
      if (!s.note) return Promise.resolve(s.buttons[0].action);
      return new Promise(() => {});
    },
    openUrl(url) { console.log('OPEN ' + url); }
  };
  const gate = await m.ensureSignedIn(ui);
  console.log('GATE ' + JSON.stringify({ choice: gate.choice, handle: gate.wallet.account && gate.wallet.account.handle }));
  console.log('PROVIDER ' + m.resolveProvider(null).kind);
  setTimeout(() => process.exit(0), Number(process.env.STAY_MS || 300));
})();
`;

let wallets = [anonymous];
let walletStatus = 200;
let installsStatus = 201;
let requests = [];
let origin = '';
let dir = '';
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/api/v1/installs') {
      if (installsStatus !== 201) return json(installsStatus, { error: { type: 'invalid_app_token', message: 'This app token is not valid.' } });
      return json(201, { key: KEY, install_id: JSON.parse(body).install_id, claim_url: `${origin}/claim/abc`, claim_state: 'anonymous' });
    }
    if (req.url === '/api/v1/wallet') {
      if (walletStatus !== 200) return json(walletStatus, { error: { type: 'invalid_key', message: 'This key is not valid.' } });
      const w = wallets.length > 1 ? wallets.shift() : wallets[0];
      return json(200, { ...w, claim_url: `${origin}/claim/abc`, top_up_url: `${origin}/wallet?top_up=1`, linked_at: null });
    }
    if (req.url === '/api/v1/telemetry') { res.writeHead(204); return res.end(); }
    return json(404, {});
  });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function fresh() {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-publik-module-'));
  fs.writeFileSync(path.join(dir, 'app.cjs'), HARNESS);
  wallets = [anonymous]; walletStatus = 200; installsStatus = 201; requests = [];
}

function run(extra = {}, timeout = 40000) {
  const env = { ...process.env };
  for (const k of ['DO_NOT_TRACK', 'PUBLIK_API_KEY', 'PUBLIK_API_BASE_URL', 'PUBLIK_TELEMETRY', 'PUBLIK_SELF_TEST', 'PUBLIK_TELEMETRY_URL']) delete env[k];
  Object.assign(env, {
    HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(dir, '.config'),
    PUBLIK_ORIGIN: origin, PUBLIK_APP_TOKEN: 'pat_gatetest', PUBLIK_TELEMETRY_DEBUG: '1', PUBLIK_TELEMETRY_INTERVAL_SECONDS: '1', PUBLIK_MODULE: MODULE,
    ...extra
  });
  return new Promise((resolve) => {
    execFile(process.execPath, ['app.cjs'], { cwd: dir, env, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ out: stdout.split('\n').filter(Boolean), err: stderr, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 });
    });
  });
}

const screens = (out) => out.filter((l) => l.startsWith('SCREEN ')).map((l) => JSON.parse(l.slice(7)));
function credentialFile() {
  const base = process.platform === 'darwin' ? path.join(dir, 'Library', 'Application Support')
    : process.platform === 'win32' ? path.join(dir, 'AppData', 'Local')
      : path.join(dir, '.config');
  return path.join(base, 'publik', 'apps', `${SLUG}.json`);
}
const credential = () => JSON.parse(fs.readFileSync(credentialFile(), 'utf8'));

test('the gate: sign in, get a plan, connect it; telemetry starts after the sign-in with the install key', async () => {
  fresh();
  wallets = [anonymous, anonymous, claimedEmpty, claimedEmpty, claimedPlan];
  const { out, err } = await run({ STAY_MS: '1600' });
  const seen = screens(out);
  assert.deepEqual(seen.map((s) => [s.title, s.note]), [
    ['Sign in with publik', null],
    ['Sign in with publik', 'Waiting for you to sign in in your browser.'],
    ['Choose how to pay for AI', null],
    ['Connect your plan', null]
  ]);
  assert.equal(seen[2].body, 'You are signed in as @mann. This app uses AI. Get a publik plan, or use your own key.');
  assert.equal(seen[3].body, 'You are signed in as @mann. Your plan: Plus. Connect it to use AI in this app, or use your own key.');
  assert.deepEqual(out.filter((l) => l.startsWith('OPEN ')), [`OPEN ${origin}/claim/abc`, `OPEN ${origin}/wallet?top_up=1`]);
  assert.ok(out.includes('GATE {"choice":"publik","handle":"mann"}'), out.join('\n'));
  assert.ok(out.includes('PROVIDER publik'));
  assert.equal(credential().key, KEY);
  assert.equal(credential().choice, 'publik');
  assert.equal((fs.statSync(credentialFile()).mode & 0o777) === 0o600 || process.platform === 'win32', true, 'the credential file is 0600');

  const events = requests.filter((r) => r.url === '/api/v1/telemetry');
  assert.ok(events.length >= 2, `telemetry events: ${events.length}`);
  assert.ok(events.every((e) => e.auth === `Bearer ${KEY}`), 'every event carries the install key');
  const first = JSON.parse(events[0].body);
  assert.equal(first.v, 1);
  assert.equal(first.app, SLUG);
  assert.equal(first.event, 'app_opened');
  assert.equal(first.app_version, VERSION);
  assert.deepEqual(Object.keys(first).filter((k) => !['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch'].includes(k)), [], 'no extra fields');
  assert.equal(JSON.parse(events[1].body).event, 'active_session');
  assert.ok(err.includes('publik-telemetry: app_opened -> 204'), err);
  assert.ok(!(out.join('\n') + err).includes(KEY), 'the key is never printed');
  assert.ok(requests.filter((r) => r.url === '/api/v1/wallet').every((r) => r.auth === `Bearer ${KEY}`), 'every /wallet carries the key');
  assert.ok(requests.filter((r) => r.url === '/api/v1/installs').every((r) => r.auth === null), '/installs carries no key');
  const installs = JSON.parse(requests.find((r) => r.url === '/api/v1/installs').body);
  assert.equal(installs.app_slug, SLUG);
  assert.equal(installs.app_version, VERSION);
  assert.equal(installs.app_token, 'pat_gatetest');
});

test('"Use my own key" is stored; the next start skips the plan screen', async () => {
  fresh();
  wallets = [claimedEmpty];
  const first = await run({ PRESS: JSON.stringify({ 'Choose how to pay for AI': 'Use my own key' }) });
  assert.deepEqual(screens(first.out).map((s) => s.title), ['Choose how to pay for AI']);
  assert.ok(first.out.includes('PROVIDER needs_own_key'));
  assert.equal(credential().choice, 'own_key');
  const second = await run();
  assert.equal(screens(second.out).length, 0, 'no screen at the second start');
  assert.ok(second.out.some((l) => l.startsWith('GATE ') && l.includes('own_key')));
});

test('no other way past the sign-in screen while anonymous, and no telemetry before the sign-in', async () => {
  fresh();
  const { out, code } = await run({ PRESS: JSON.stringify({ 'Sign in with publik': 'Sign in with publik' }), SCREEN_LIMIT: '2' });
  assert.equal(code, 3, 'the harness gave up after 3 screens');
  assert.ok(!out.some((l) => l.startsWith('GATE ')), 'never resolved');
  assert.ok(screens(out).every((s) => s.title === 'Sign in with publik' && s.buttons.length === 1));
  assert.ok(!requests.some((r) => r.url === '/api/v1/telemetry'));
});

test('publik not reachable shows Retry and nothing else', async () => {
  fresh();
  const { out, code } = await run({ PUBLIK_ORIGIN: 'http://127.0.0.1:9', SCREEN_LIMIT: '2' });
  const seen = screens(out);
  assert.equal(code, 3);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.title === 'Sign in with publik' && s.body === 'publik is not reachable. Check your connection.' && s.buttons.join() === 'Retry'));
});

test('a revoked key (401) provisions a new one at the next start', async () => {
  fresh();
  wallets = [claimedPlan];
  const first = await run({ PRESS: JSON.stringify({ 'Connect your plan': 'Connect your plan' }) });
  assert.ok(first.out.includes('PROVIDER publik'));
  walletStatus = 401; requests = [];
  await run({ PRESS: JSON.stringify({ 'Sign in with publik': 'exit' }) }, 15000);
  assert.ok(requests.filter((r) => r.url === '/api/v1/installs').length >= 2, 'provisioned again after a 401');
});

test('PUBLIK_SELF_TEST prints the ok line only after a real GET /wallet, and names each failure', async () => {
  fresh();
  const ok = await run({ PUBLIK_SELF_TEST: '1' });
  assert.deepEqual(ok.out, [`publik self-test: ok ${SLUG} ${VERSION}`]);
  assert.deepEqual(requests.map((r) => r.url), ['/api/v1/installs', '/api/v1/wallet']);
  requests = []; walletStatus = 500;
  const failed = await run({ PUBLIK_SELF_TEST: '1' });
  assert.deepEqual(failed.out, ['publik self-test: failed: This key is not valid.']);
  const offline = await run({ PUBLIK_SELF_TEST: '1', PUBLIK_ORIGIN: 'http://127.0.0.1:9' });
  assert.deepEqual(offline.out, ['publik self-test: failed: publik is not reachable. Check your connection.']);
  installsStatus = 401; walletStatus = 200;
  const bad = await run({ PUBLIK_SELF_TEST: '1' });
  assert.deepEqual(bad.out, ['publik self-test: failed: This app token is not valid.']);
});

test('DO_NOT_TRACK=1: no telemetry, the gate still runs', async () => {
  fresh();
  wallets = [claimedPlan];
  const { out, err } = await run({ DO_NOT_TRACK: '1', PRESS: JSON.stringify({ 'Connect your plan': 'Connect your plan' }) });
  assert.ok(out.includes('PROVIDER publik'));
  assert.ok(!requests.some((r) => r.url === '/api/v1/telemetry'));
  assert.ok(err.includes('publik-telemetry: app_opened -> off (opt-out)'), err);
});

test('the module is the one file the publik scan reads: the slug, the installs, telemetry and app_opened strings', () => {
  const src = fs.readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /\bAPP_SLUG\s*=\s*"cue"/);
  for (const needle of ['/api/v1/installs', '/api/v1/telemetry', 'app_opened', '/api/v1/wallet']) assert.ok(src.includes(needle), needle);
  // The old standalone telemetry client is gone: one module, not two.
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'publik-telemetry.cjs')), false);
  // main.js runs the gate before any window and never holds a second publik client.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /gate = await publikModule\.ensureSignedIn\(gateUI\);/);
  assert.ok(main.indexOf('publikModule.ensureSignedIn(gateUI)') < main.indexOf('launchApp();\n  app.on(\'activate\''), 'the gate runs before launchApp');
  assert.doesNotMatch(main, /publik-telemetry/);
});
