// When cue gives up on an answer (watchdog, slide caption timer), the HTTP
// request must close, or publik keeps generating and billing it. Base 0.2.10
// showed "timed out" at 25 s and was billed for 700 tokens at 42 s.
// This test uses the real OpenAI SDK against a local server that streams
// thinking and never answers, then checks that the server sees the
// connection close soon after cue aborts.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const { createLLM } = require('../src/llm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('giving up closes the provider connection: the server stops streaming at once', async () => {
  const log = [];
  let t0 = 0;
  let closedAt = null;
  let thinkingSent = 0;
  const server = http.createServer((req, res) => {
    t0 = Date.now();
    log.push('request ' + req.method + ' ' + req.url);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = () => 'data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'publik-balanced', choices: [{ index: 0, delta: { reasoning: 'thinking ' }, finish_reason: null }] }) + '\n\n';
    const iv = setInterval(() => { thinkingSent++; res.write(chunk()); }, 50);
    const end = setTimeout(() => { clearInterval(iv); res.end('data: [DONE]\n\n'); log.push('ended'); }, 5000);
    res.on('close', () => { clearInterval(iv); clearTimeout(end); closedAt = Date.now() - t0; log.push('closed'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const llm = createLLM({
      provider: 'publik', smart: false,
      apiKeys: { publik: 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345' },
      publik: { baseUrl: `http://127.0.0.1:${port}/v1` },
      models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } }
    });
    const controller = new AbortController();
    let thinkingSeen = 0;
    const answer = llm.stream({
      system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: 'data:image/jpeg;base64,AAAA',
      onToken: () => {}, onActivity: (kind) => { if (kind === 'thinking') thinkingSeen++; },
      signal: controller.signal
    });
    answer.catch(() => {});
    await sleep(400);
    assert.ok(thinkingSeen > 0, 'cue saw the thinking stream');
    const gaveUpAt = Date.now() - t0;
    controller.abort(new Error('gave up'));            // what the watchdog / caption timer do
    await assert.rejects(answer);
    for (let i = 0; i < 40 && closedAt === null; i++) await sleep(25);
    assert.ok(closedAt !== null, `the server saw no close (log: ${log.join(', ')})`);
    assert.ok(closedAt - gaveUpAt < 500, `closed ${closedAt - gaveUpAt} ms after cue gave up`);
    assert.ok(!log.includes('ended'), 'the server did not stream to its end');
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
