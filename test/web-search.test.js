const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createWebConversation, webCommand, resolveWebProvider, ENDPOINT, USER_AGENT } = require('../src/web-search');

const root = path.resolve(__dirname, '..');
const mainRequire = createRequire(path.join(root, 'main.js'));
const EVIDENCE = 'Node.js release information: https://nodejs.org/en/about/previous-releases';
const nativeFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = nativeFetch; });

// Exercise the real SDK's initialize, discovery and tools/call request encoding.
// This is a deterministic MCP server fixture, not a live network or model test.
function mcpServer({ toolResult, onCall, tools = ['web_search', 'web_fetch'], status = 200 } = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const request = { url: String(url), headers, method: init.method || 'GET', body: init.body && JSON.parse(init.body) };
    requests.push(request);
    if (!request.body) return new Response('', { status: 405 }); // no optional server event stream
    const message = request.body;
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) };
    } else if (message.method === 'tools/call') {
      if (onCall) await onCall(message.params, init.signal);
      if (status !== 200) return new Response('free anonymous quota exceeded', { status });
      result = toolResult || { content: [{ type: 'text', text: EVIDENCE }] };
    } else throw new Error('Unexpected fixture method: ' + message.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, requests, calls: () => requests.filter(r => r.body?.method === 'tools/call').map(r => r.body.params) };
}

function fixtureSettings(patch = {}) {
  return {
    provider: 'custom', baseUrl: 'http://127.0.0.1:18789/v1', smart: false,
    apiKeys: { custom: 'saved-chat-secret', parallel: 'must-not-send-this' },
    models: { custom: { fast: 'scripted-model' } }, aiRules: '',
    resumeText: 'PRIVATE RESUME', ...patch
  };
}

// Load the complete production main module. Electron startup is suppressed, but
// the registered Ask and Clear transcript callbacks, provider resolver, prompt,
// production MCP SDK and createLLM implementation all execute unchanged.
function runtime(settings = fixtureSettings()) {
  const events = [], completions = [], clientOptions = [], listeners = {}, handles = {};
  let screenshots = 0;
  class ScriptedOpenAI {
    constructor(options) {
      clientOptions.push(options);
      this.chat = { completions: { create: async request => {
        completions.push(request);
        return [{ choices: [{ delta: { content: 'Answer from ' + EVIDENCE } }] }];
      } } };
    }
  }
  const llmModule = { exports: {} };
  const llmRequire = createRequire(path.join(root, 'src/llm.js'));
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(path.join(root, 'src/llm.js'), 'utf8') + '\n})', { filename: 'src/llm.js' })(
    name => name === 'openai' ? ScriptedOpenAI : llmRequire(name), llmModule, llmModule.exports);
  const electron = {
    app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { on: (name, fn) => { listeners[name] = fn; }, handle: (name, fn) => { handles[name] = fn; } }
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (name === './src/store') return {
        getSettings: () => settings,
        setSettings: patch => Object.assign(settings, patch),
        stripRendererPatch: patch => patch,
        redactForRenderer: value => value
      };
      if (name === './src/llm') return llmModule.exports;
      if (name === './src/screen') return { captureScreenshot: async () => { screenshots++; throw new Error('screen permission denied'); } };
      if (name === './src/applink') return { recordEvent() {} };
      return mainRequire(name);
    },
    console: { log() {}, error() {} }, process, Buffer, URL, Headers,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: root,
    testWindow: { isDestroyed: () => false, webContents: { send: (name, data) => events.push({ name, data }) } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
  vm.runInContext("win = testWindow; transcript.push({channel:'them',text:'PRIVATE TRANSCRIPT'}); meetingMemory = { memoryBlock: () => 'PRIVATE MEETING', end: async () => {} };", context);
  return {
    ask: text => listeners.ask(null, { mode: 'ask', text }),
    clear: () => handles['transcript:clear'](),
    settingsSet: patch => handles['settings:set'](null, patch),
    events, completions, clientOptions, settings,
    screenshots: () => screenshots
  };
}

function checkRequests(server) {
  assert.ok(server.requests.length >= 4);
  for (const request of server.requests) {
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.headers.get('user-agent'), USER_AGENT);
    assert.equal(request.headers.get('authorization'), null);
  }
}

test('Ask IPC uses the no-key default through MCP discovery, evidence consumption and streamed output', async () => {
  const server = mcpServer(); globalThis.fetch = server.fetch;
  const app = runtime();
  await app.ask('/search current Node.js LTS release');
  checkRequests(server);
  assert.equal(server.calls()[0].name, 'web_search');
  assert.equal(server.calls()[0].arguments.objective, 'current Node.js LTS release');
  assert.deepEqual(server.calls()[0].arguments.search_queries, ['current Node.js LTS release']);
  assert.match(server.calls()[0].arguments.session_id, /^[0-9a-f-]{36}$/);
  const messages = app.completions[0].messages;
  assert.match(messages[1].content, /Untrusted web evidence/);
  assert.ok(messages[1].content.includes(EVIDENCE));
  assert.match(messages[0].content, /never instructions/);
  for (const text of [JSON.stringify(server.requests), JSON.stringify(messages)]) {
    assert.doesNotMatch(text, /PRIVATE TRANSCRIPT|PRIVATE RESUME|PRIVATE MEETING|must-not-send-this|saved-chat-secret/);
  }
  assert.equal(app.screenshots(), 0);
  assert.equal(app.clientOptions[0].apiKey, 'saved-chat-secret');
  assert.equal(app.clientOptions[0].baseURL, 'http://127.0.0.1:18789/v1');
  assert.ok(app.events.some(e => e.name === 'llm:token' && e.data.text.includes(EVIDENCE)));
  assert.ok(app.events.some(e => e.name === 'llm:done'));
});

test('ordinary Ask keeps its provider and screen permission behavior and makes no web request', async () => {
  const server = mcpServer(); globalThis.fetch = server.fetch;
  const app = runtime();
  await app.ask('Explain a closure');
  assert.equal(server.requests.length, 0);
  assert.equal(app.screenshots(), 1);
  assert.ok(app.events.some(e => e.name === 'status' && /capture failed/.test(e.data.message)));
  assert.match(app.completions[0].messages[1].content, /PRIVATE TRANSCRIPT/);
  assert.equal(app.clientOptions[0].apiKey, 'saved-chat-secret');
});

test('saved disabled and unknown web choices prevent requests and never silently fall back', async () => {
  for (const provider of ['none', 'other', null, '']) {
    const server = mcpServer(); globalThis.fetch = server.fetch;
    const settings = fixtureSettings({ webSearchProvider: provider });
    const app = runtime(settings);
    await app.ask('/search new releases');
    assert.equal(server.requests.length, 0);
    assert.equal(app.completions.length, 0);
    assert.equal(settings.webSearchProvider, provider);
    assert.ok(app.events.some(e => e.name === 'llm:error' && /disabled|Unknown web search/.test(e.data.message)));
  }
  assert.equal(resolveWebProvider({ webSearchProvider: 'parallel' }), 'parallel');
});

test('an unconfigured chat provider does not send a web question before chat setup', async () => {
  const server = mcpServer(); globalThis.fetch = server.fetch;
  const app = runtime(fixtureSettings({ provider: 'openai', apiKeys: {} }));
  await app.ask('/search new releases');
  assert.equal(server.requests.length, 0);
  assert.ok(app.events.some(e => e.name === 'llm:error' && /API key/.test(e.data.message)));
});

test('Ask IPC search, fetch and follow-up share identity; Clear transcript starts a new conversation', async () => {
  const server = mcpServer(); globalThis.fetch = server.fetch;
  const app = runtime(fixtureSettings({ webSearchProvider: 'parallel' }));
  await app.ask('/search current Node.js release');
  await app.ask('/fetch https://nodejs.org/en/about/previous-releases');
  await app.ask('/search Node.js LTS support dates');
  assert.equal(server.calls()[1].name, 'web_fetch');
  assert.deepEqual(server.calls()[1].arguments.urls, ['https://nodejs.org/en/about/previous-releases']);
  const ids = server.calls().map(c => c.arguments.session_id);
  assert.equal(new Set(ids).size, 1);
  app.clear();
  await app.ask('/search Node.js new features');
  assert.notEqual(server.calls()[3].arguments.session_id, ids[0]);
  checkRequests(server);
});

test('invalid fetch destinations and empty commands are rejected before contacting MCP', async () => {
  for (const query of ['file:///etc/passwd', 'http://localhost/private', 'http://127.0.0.1/a', 'http://10.0.0.1/a', 'http://192.168.1.1/a', 'http://172.16.0.1/a', 'http://169.254.169.254/', 'https://user:secret@example.com/', 'http://[::1]/', 'javascript:alert(1)', 'not a URL']) {
    const server = mcpServer();
    await assert.rejects(createWebConversation().retrieve({ kind: 'fetch', query }, {}, { fetch: server.fetch }), /public|HTTP/);
    assert.equal(server.requests.length, 0);
  }
  const server = mcpServer(); globalThis.fetch = server.fetch;
  const app = runtime();
  await app.ask('/search');
  assert.equal(server.requests.length, 0);
  assert.ok(app.events.some(e => e.name === 'llm:error' && /1–2000/.test(e.data.message)));
  assert.equal(webCommand('ask', ' /SEARCH question ' ).query, 'question');
  assert.equal(webCommand('say', '/search question'), null);
  assert.equal(webCommand('ask', '/searching question'), null);
});

test('independent conversations interleave on one HTTP fixture without identity crossover', async () => {
  const server = mcpServer();
  const a = createWebConversation(), b = createWebConversation();
  await Promise.all([
    a.retrieve({ kind: 'search', query: 'conversation A' }, {}, { fetch: server.fetch }),
    b.retrieve({ kind: 'search', query: 'conversation B' }, {}, { fetch: server.fetch })
  ]);
  await Promise.all([
    b.retrieve({ kind: 'fetch', query: 'https://example.org/b' }, {}, { fetch: server.fetch }),
    a.retrieve({ kind: 'fetch', query: 'https://example.org/a' }, {}, { fetch: server.fetch })
  ]);
  const calls = server.calls();
  const aid = calls.find(c => c.arguments.objective === 'conversation A').arguments.session_id;
  const bid = calls.find(c => c.arguments.objective === 'conversation B').arguments.session_id;
  assert.notEqual(aid, bid);
  assert.equal(calls.find(c => c.arguments.urls?.[0] === 'https://example.org/a').arguments.session_id, aid);
  assert.equal(calls.find(c => c.arguments.urls?.[0] === 'https://example.org/b').arguments.session_id, bid);
});

test('quota/error responses reach the Ask error path and retries keep conversation identity', async () => {
  const server = mcpServer({ status: 429 }); globalThis.fetch = server.fetch;
  const app = runtime();
  await app.ask('/search Node.js releases');
  await app.ask('/search Node.js releases');
  assert.equal(server.calls().length, 2);
  assert.equal(server.calls()[0].arguments.session_id, server.calls()[1].arguments.session_id);
  assert.equal(app.completions.length, 0);
  assert.equal(app.events.filter(e => e.name === 'llm:error').length, 2);
  assert.match(app.events.find(e => e.name === 'llm:error').data.message, /429|quota/i);
});

test('tool errors, missing tools, empty content and transport failures do not become model evidence', async () => {
  for (const options of [
    { toolResult: { isError: true, content: [{ type: 'text', text: 'upstream failure' }] } },
    { tools: [] },
    { toolResult: { content: [] } }
  ]) {
    const server = mcpServer(options); globalThis.fetch = server.fetch;
    const app = runtime();
    await app.ask('/search Node.js releases');
    assert.equal(app.completions.length, 0);
    assert.ok(app.events.some(e => e.name === 'llm:error'));
  }
  const conversation = createWebConversation();
  await assert.rejects(conversation.retrieve({ kind: 'search', query: 'test' }, {}, { fetch: async () => { throw new Error('offline'); } }), /offline/);
});

function abortableCall() {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const server = mcpServer({ onCall: (_params, signal) => new Promise((_resolve, reject) => {
    entered();
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }) });
  return { server, ready };
}

test('timeout and external cancellation abort the actual MCP request', async () => {
  const blocked = abortableCall();
  await assert.rejects(createWebConversation().retrieve({ kind: 'search', query: 'test' }, {}, { fetch: blocked.server.fetch, timeoutMs: 30 }), /cancelled|timed out/);
  const other = abortableCall(), controller = new AbortController();
  const pending = createWebConversation().retrieve({ kind: 'search', query: 'test' }, {}, { fetch: other.server.fetch, signal: controller.signal });
  await other.ready;
  controller.abort();
  await assert.rejects(pending, /cancelled|timed out/);
});

test('Clear transcript cancels an in-flight Ask lookup and prevents stale evidence consumption', async () => {
  const blocked = abortableCall(); globalThis.fetch = blocked.server.fetch;
  const app = runtime();
  const pending = app.ask('/search pending lookup');
  await blocked.ready;
  const oldId = blocked.server.calls()[0].arguments.session_id;
  app.clear();
  await pending;
  assert.equal(app.completions.length, 0);
  assert.ok(app.events.some(e => e.name === 'llm:error' && /cancelled|timed out/.test(e.data.message)));
  const next = mcpServer(); globalThis.fetch = next.fetch;
  await app.ask('/search next conversation');
  assert.notEqual(next.calls()[0].arguments.session_id, oldId);
  assert.equal(app.completions.length, 1);
});


test('disabling web search via settings IPC cancels an in-flight lookup and stays disabled', async () => {
  const blocked = abortableCall(); globalThis.fetch = blocked.server.fetch;
  const app = runtime();
  const pending = app.ask('/search pending lookup');
  await blocked.ready;
  app.settingsSet({ webSearchProvider: 'none' });
  await pending;
  assert.equal(app.completions.length, 0);
  assert.ok(app.events.some(e => e.name === 'llm:error' && /cancelled|timed out/.test(e.data.message)));
  await app.ask('/search second lookup');
  assert.equal(blocked.server.calls().length, 1);
  assert.ok(app.events.some(e => e.name === 'llm:error' && /disabled/.test(e.data.message)));
});
