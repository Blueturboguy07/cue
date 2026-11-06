// Fixes for the failures the v0.2.6 smoke test found (2026-11-02):
//   test 5  - screen questions on publik's fast tier were answered wrongly;
//   test 6  - a Mac user on publik with no audio key of their own got no transcript;
//   test 9  - after a dashboard revoke, the first Reconnect press did nothing visible;
//   test 12 - closing Settings switched a person who picked publik back to an old own key.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

let clients = [];        // every FakeOpenAI constructed: { options, chatRequests, audioRequests }
let audioError = null;   // when set, audio.transcriptions.create rejects with it
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    class FakeOpenAI {
      constructor(options) {
        const rec = { options, chatRequests: [], audioRequests: [] };
        clients.push(rec);
        this.chat = { completions: { create: (req) => { rec.chatRequests.push(req); return Promise.resolve([{ choices: [{ delta: { content: 'ok' } }] }]); } } };
        this.audio = { transcriptions: { create: (req) => { rec.audioRequests.push(req); return audioError ? Promise.reject(audioError) : Promise.resolve({ text: 'hello from the meeting' }); } } };
      }
    }
    FakeOpenAI.toFile = async (buf, name, opts) => ({ name, type: opts && opts.type, size: buf.length });
    return FakeOpenAI;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM } = require('../src/llm');
const { createSTT, publikTranscription, PUBLIK_STT_MODEL } = require('../src/stt');
const publik = require('../src/publik');

test.after(() => { Module._load = originalModuleLoad; });
test.beforeEach(() => { clients = []; audioError = null; });

const PUBLIK_KEY = 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32);
const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');

function publikSettings(overrides = {}) {
  return {
    provider: 'publik',
    smart: false,
    sttProvider: 'auto',
    apiKeys: { publik: PUBLIK_KEY },
    publik: { baseUrl: 'https://publikhq.com/api/v1', revoked: false },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
    ...overrides
  };
}

// ---- test 5: a screenshot question goes to a model that can read a screen ----

test('publik fast tier: a question with a screenshot is sent to the smart alias (publik-balanced)', async () => {
  const llm = createLLM(publikSettings());
  assert.equal(llm.model, 'publik-fast');
  assert.equal(llm.visionModel, 'publik-balanced');
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'Which website is open?' }], imageDataUrl: IMAGE, onToken: () => {} });
  const req = clients[0].chatRequests[0];
  assert.equal(req.model, 'publik-balanced');
  assert.equal(req.messages[1].content[1].type, 'image_url', 'the screenshot is still attached');
});

test('publik fast tier: a text-only question stays on publik-fast', async () => {
  const llm = createLLM(publikSettings());
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'What is 17 times 23?' }], onToken: () => {} });
  assert.equal(clients[0].chatRequests[0].model, 'publik-fast');
});

test('publik: the server-provided smart alias is used for screenshots; cleared fields fall back to publik-balanced', async () => {
  const fromServer = createLLM(publikSettings({ models: { publik: { fast: 'publik-fast', smart: 'publik-default' } } }));
  assert.equal(fromServer.visionModel, 'publik-default');
  const cleared = createLLM(publikSettings({ models: { publik: { fast: '', smart: '' } } }));
  assert.equal(cleared.model, 'publik-fast');
  assert.equal(cleared.visionModel, 'publik-balanced');
});

test('publik: Smart on keeps the smart model for screenshots; an own Fast model choice is respected', async () => {
  assert.equal(createLLM(publikSettings({ smart: true })).visionModel, 'publik-balanced');
  const own = createLLM(publikSettings({ models: { publik: { fast: 'gpt-4o', smart: 'publik-balanced' } } }));
  assert.equal(own.model, 'gpt-4o');
  assert.equal(own.visionModel, 'gpt-4o');
});

test('other providers: a screenshot never changes the model', async () => {
  const llm = createLLM({ provider: 'openai', smart: false, apiKeys: { openai: 'sk-test' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } });
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, onToken: () => {} });
  assert.equal(clients[0].chatRequests[0].model, 'gpt-4o-mini');
});

// ---- test 6: publik transcribes for a publik user with no audio key ----

test('publik user with no audio key: listening transcribes through publik API (whisper-1, publik base URL, minted key)', async () => {
  const stt = createSTT(publikSettings());
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['publik']);
  assert.deepEqual(stt.models, [PUBLIK_STT_MODEL]);
  assert.equal(PUBLIK_STT_MODEL, 'whisper-1');
  const pcm = Buffer.alloc(16000 * 2, 1); // one second of 16 kHz mono PCM
  const res = await stt.transcribe(pcm);
  assert.deepEqual(res, { text: 'hello from the meeting', provider: 'publik' });
  // 30 s timeout, no SDK retries: main.js tries a failed piece once more itself (round 2 of the STT cuts).
  assert.deepEqual(clients[0].options, { apiKey: PUBLIK_KEY, baseURL: 'https://publikhq.com/api/v1', timeout: 30000, maxRetries: 0 });
  assert.equal(clients[0].audioRequests[0].model, 'whisper-1');
  assert.equal(clients[0].audioRequests[0].file.type, 'audio/wav');
});

test('publik transcription uses the provisioning base URL and never the Custom slot', () => {
  const t = publikTranscription(publikSettings({ baseUrl: 'http://127.0.0.1:18789/v1', publik: { baseUrl: 'https://publikhq.com/api/v1-next/' } }));
  assert.equal(t.baseURL, 'https://publikhq.com/api/v1-next');
  assert.equal(publikTranscription(publikSettings({ publik: {} })).baseURL, publik.DEFAULT_BASE_URL);
});

// 0.2.9 (smoke test v0.2.8): with publik as the provider, Auto audio is
// publik only. An old own key is used only when it is picked on the Audio tab.
test('publik provider + Auto audio: publik transcribes, an own audio key is not tried first', () => {
  const stt = createSTT(publikSettings({ apiKeys: { publik: PUBLIK_KEY, groq: 'gsk-test', openai: 'sk-old' } }));
  assert.deepEqual(stt.providers, ['publik']);
  assert.deepEqual(createSTT(publikSettings({ sttProvider: 'groq', apiKeys: { publik: PUBLIK_KEY, groq: 'gsk-test' } })).providers, ['groq']);
});

test('publik never transcribes when it is not the selected provider, its key is revoked or missing, or STT is set explicitly', () => {
  assert.equal(createSTT(publikSettings({ provider: 'anthropic', apiKeys: { publik: PUBLIK_KEY, anthropic: 'sk-ant' } })).available, false);
  assert.equal(createSTT(publikSettings({ publik: { baseUrl: '', revoked: true } })).available, false);
  assert.equal(createSTT(publikSettings({ apiKeys: { publik: '' } })).available, false);
  assert.equal(createSTT(publikSettings({ sttProvider: 'local' })).available, false);
  assert.deepEqual(createSTT(publikSettings({ sttProvider: 'openai' })).providers, []);
});

test('a publik transcription failure carries the gateway sentence and its one button, not "[object Error]"', async () => {
  const e = new Error('402');
  e.status = 402;
  e.error = { type: 'insufficient_credit', message: 'Your publik balance is used up.', claim_state: 'claimed', top_up_url: 'https://publikhq.com/dashboard/api' };
  audioError = e;
  const res = await createSTT(publikSettings()).transcribe(Buffer.alloc(16000 * 2, 1));
  assert.equal(res.text, '');
  assert.equal(res.error.provider, 'publik');
  assert.equal(typeof res.error.message, 'string');
  assert.equal(res.error.message, 'Your publik balance is used up.');
  assert.deepEqual(res.error.action, { kind: 'link', label: 'Add a plan or pack', url: 'https://publikhq.com/dashboard/api' });
});

test('the publik data-path copy names audio, since listening can now go through publik', () => {
  assert.match(publik.COPY.dataPath, /screenshots and, while cue listens, your audio go through publik's servers/);
  assert.match(publik.COPY.disclosure.dataPath, /screenshots and, while cue listens, your audio go through publik's servers/);
});

// ---- test 9: a 401 on a question marks the key revoked ----

test('a 401 from the gateway tells main.js the key on disk is dead (action.revoked)', () => {
  const removed = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: false } });
  assert.deepEqual(removed.action, { kind: 'reconnect', label: 'Reconnect', revoked: 'key_revoked' });
  const invalid = publik.describeGatewayError({ status: 401, body: { type: 'invalid_api_key' } });
  assert.deepEqual(invalid.action, { kind: 'reconnect', label: 'Reconnect', revoked: 'invalid_key' });
  const idle = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: true } });
  assert.deepEqual(idle.action, { kind: 'reprovision' });
});

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('main.js: a reconnect action with revoked marks the key, and publik:reconnect runs reconnectInstall', () => {
  const start = mainSrc.indexOf('function publikHandleErrorAction(action)');
  const body = mainSrc.slice(start, mainSrc.indexOf('\n}\n', start));
  assert.match(body, /action\.kind === 'reconnect' && action\.revoked/);
  assert.match(body, /publikHandleRevoked\(\{ type: action\.revoked === 'key_revoked' \? 'key_revoked' : 'invalid_api_key', reprovision: false \}\)/);
  assert.match(mainSrc, /ipcMain\.handle\('publik:reconnect', \(\) => publik\.reconnectInstall\(\{/);
});

// ---- test 12: closing Settings keeps publik selected ----

const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
function fnSource(name) {
  const start = rendererSrc.indexOf(`async function ${name}()`);
  assert.ok(start > -1, `${name} not found in renderer.js`);
  const end = rendererSrc.indexOf('\n  }\n', start);
  return rendererSrc.slice(start, end + 4);
}

// Runs the real saveSettings source against fake inputs. `typed` is what the
// key fields hold at close; `atOpen` the keys Settings showed when it opened.
async function closeSettingsWith({ settings, publikState, typed = {}, atOpen }) {
  const ids = ['cerebras', 'openai', 'anthropic', 'groq', 'custom', 'gemini', 'deepgram', 'ollama', 'minimax', 'deepseek', 'azure'];
  const values = { '#base-url': '', '#azure-endpoint': '', '#model-fast': '', '#model-smart': '', '#whisper-model': 'base.en', '#whisper-language': 'auto', '#whisper-threads': '0', '#ai-rules': '' };
  for (const id of ids) values[`#key-${id}`] = typed[id] !== undefined ? typed[id] : (settings.apiKeys[id] || '');
  const el = (id) => ({ value: values[id] !== undefined ? values[id] : '', textContent: '', focus() {}, checked: false });
  let saved = null;
  const ctx = vm.createContext({
    $: el, settings, publikState, keysAtOpen: atOpen || { ...settings.apiKeys },
    cue: { settingsSet: async (s) => { saved = JSON.parse(JSON.stringify(s)); return s; } },
    clampOpacity: (x) => x, statusText: () => '', updateSmartTooltip: () => {}, Number
  });
  vm.runInContext(`${fnSource('saveSettings')}\nthis.run = saveSettings;`, ctx);
  assert.equal(await ctx.run(), true);
  return saved;
}

const V024 = () => ({ provider: 'publik', apiKeys: { openai: 'sk-from-0.2.4', publik: '' }, models: { publik: { fast: '', smart: '' } }, localWhisper: {}, slides: {} });

test('0.2.4 user with an own OpenAI key who set up publik: closing Settings keeps publik (smoke test 12)', async () => {
  const saved = await closeSettingsWith({ settings: V024(), publikState: { connected: true, revoked: false } });
  assert.equal(saved.provider, 'publik');
  assert.equal(saved.apiKeys.openai, 'sk-from-0.2.4', 'the own key is kept');
});

test('picking publik without finishing set-up also survives a close (no flip to the old key)', async () => {
  const saved = await closeSettingsWith({ settings: V024(), publikState: { connected: false, revoked: false } });
  assert.equal(saved.provider, 'publik');
});

test('a connected publik user who types a Groq key for transcription stays on publik', async () => {
  const s = V024();
  const saved = await closeSettingsWith({ settings: s, publikState: { connected: true, revoked: false }, typed: { groq: 'gsk-new' }, atOpen: { ...s.apiKeys } });
  assert.equal(saved.provider, 'publik');
  assert.equal(saved.apiKeys.groq, 'gsk-new');
});

test('the original rule still works: no key for the selected provider + a key typed in this visit switches to it', async () => {
  const s = { provider: 'openai', apiKeys: { openai: '' }, models: {}, localWhisper: {}, slides: {} };
  const saved = await closeSettingsWith({ settings: s, publikState: null, typed: { anthropic: 'sk-ant-new' }, atOpen: { openai: '' } });
  assert.equal(saved.provider, 'anthropic');
});

test('publik not set up + a key typed in this visit: follows the typed key', async () => {
  const s = V024();
  const saved = await closeSettingsWith({ settings: s, publikState: { connected: false, revoked: false }, typed: { gemini: 'AIza-new' }, atOpen: { ...s.apiKeys } });
  assert.equal(saved.provider, 'gemini');
});

test('renderer: Settings remembers the keys it opened with, and a toast Reconnect says what happened', () => {
  assert.match(rendererSrc, /function fillSettings\(\) \{\n    keysAtOpen = \{ \.\.\.\(settings\.apiKeys \|\| \{\}\) \};/);
  // 0.2.10: the toast Reconnect takes the overlay path (claim page + link
  // poll); it says what happened only when no claim page opens.
  assert.match(rendererSrc, /if \(!\(await reconnectPublik\(\)\)\) showReconnectResult\(publikState\);/);
  assert.match(rendererSrc, /cue\.on\('status', \(\{ message, action \}\) =>/);
});
