// Explicit web commands. No screen, meeting, profile or AI credentials enter MCP.
const { randomUUID } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { version } = require('../package.json');

const ENDPOINT = 'https://search.parallel.ai/mcp';
const USER_AGENT = `cue/${version} (https://github.com/Blueturboguy07/cue)`;
const TIMEOUT_MS = 12000;
const MAX_EVIDENCE_CHARS = 25000;

function webCommand(mode, text) {
  if (mode !== 'ask' || typeof text !== 'string') return null;
  const match = /^\/(search|fetch)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { kind: match[1].toLowerCase(), query: (match[2] || '').trim() } : null;
}

function publicUrl(text) {
  let url;
  try { url = new URL(text); } catch { throw new Error('Use /fetch followed by one public HTTP or HTTPS URL.'); }
  // Fetching is performed remotely. Reject local destinations and credentials
  // rather than implying that Parallel can read files or local services.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      !host.includes('.') || host.includes(':') ||
      /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error('Use a public HTTP or HTTPS URL without embedded credentials.');
  }
  return url.href;
}

function resolveWebProvider(settings) {
  const provider = settings.webSearchProvider === undefined ? 'parallel' : settings.webSearchProvider;
  if (provider === 'none') throw new Error('Web search is disabled in Settings.');
  if (provider !== 'parallel') throw new Error('Unknown web search provider. Choose a provider in Settings.');
  return provider;
}

function createWebConversation() {
  // The app owns this object for one conversation. Connections can come and go
  // without changing identity; reset cancels the old work and begins a new one.
  let context = { id: randomUUID(), controller: new AbortController() };
  return {
    reset() {
      context.controller.abort();
      context = { id: randomUUID(), controller: new AbortController() };
    },
    async retrieve(command, settings, { signal, fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
      resolveWebProvider(settings);
      const query = command.query.trim();
      if (!query || query.length > 2000) throw new Error('Enter a web query or URL of 1–2000 characters after the command.');
      const args = command.kind === 'fetch' ? { urls: [publicUrl(query)] } : {
        objective: query,
        search_queries: [query.split(/\s+/).slice(0, 6).join(' ')]
      };
      const current = context;
      args.session_id = current.id;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const signals = [signal, current.controller.signal].filter(Boolean);
      for (const s of signals) {
        if (s.aborted) cancel();
        s.addEventListener('abort', cancel, { once: true });
      }
      const timer = setTimeout(cancel, timeoutMs);
      const client = new Client({ name: 'cue', version }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { 'User-Agent': USER_AGENT } },
        fetch: (url, init) => fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
      });
      const options = { signal: controller.signal, timeout: timeoutMs };
      try {
        if (controller.signal.aborted) throw new Error('Web request cancelled.');
        await client.connect(transport, options);
        const { tools } = await client.listTools({}, options);
        const name = command.kind === 'fetch' ? 'web_fetch' : 'web_search';
        if (!tools.some(tool => tool.name === name)) throw new Error(`Parallel does not offer ${name}.`);
        const result = await client.callTool({ name, arguments: args }, undefined, options);
        if (result.isError) throw new Error('Parallel could not complete this web request. Please try again later.');
        const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, MAX_EVIDENCE_CHARS);
        if (!text.trim()) throw new Error('Parallel returned no web evidence.');
        if (controller.signal.aborted) throw new Error('Web request cancelled.');
        return text;
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Web request cancelled or timed out. Please try again.');
        throw error;
      } finally {
        clearTimeout(timer);
        for (const s of signals) s.removeEventListener('abort', cancel);
        await client.close().catch(() => {});
      }
    }
  };
}

module.exports = { webCommand, createWebConversation, resolveWebProvider, ENDPOINT, USER_AGENT };
