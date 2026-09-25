const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

// Stand-in for the `ws` package: starts CONNECTING, and — like the real thing —
// closing it mid-handshake emits an 'error' ("closed before the connection was
// established") followed by an abnormal 'close'.
const sockets = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    sockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close(code) {
    if (this.readyState === 0) {
      this.readyState = 3;
      this.emit('error', new Error('WebSocket was closed before the connection was established'));
      this.emit('close', 1006);
      return;
    }
    this.readyState = 3;
    this.emit('close', code);
  }
  open() { this.readyState = 1; this.emit('open'); }
}
const wsPath = require.resolve('ws');
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };
const { DeepgramStreamingSTT, OpenAIRealtimeSTT } = require('../src/stt-streaming');

// node:test's mock timers took an array before Node 20.4 and take { apis } after it.
// CI still runs Node 18, so accept both forms.
function enableMockTimeout(t) {
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  } catch (err) {
    if (err.code !== 'ERR_INVALID_ARG_TYPE') throw err;
    t.mock.timers.enable(['setTimeout']);
  }
}

for (const [name, Ctor] of [['Deepgram', DeepgramStreamingSTT], ['OpenAI Realtime', OpenAIRealtimeSTT]]) {
  test(`${name}: disconnect() during the handshake is not reported as a provider error and does not reconnect`, async (t) => {
    enableMockTimeout(t);
    sockets.length = 0;
    const errors = [];
    const statuses = [];
    const stt = new Ctor('key', { onError: (e) => errors.push(e), onStatusChange: (s) => statuses.push(s) });
    await stt.connect();
    assert.equal(sockets.length, 1);
    stt.disconnect(); // user toggled listening off before the socket opened
    assert.deepEqual(errors, [], 'our own close must not surface as an error');
    assert.deepEqual(statuses, [], 'a socket that never opened has no status to report');
    t.mock.timers.tick(20000);
    assert.equal(sockets.length, 1, 'must not reconnect after an explicit disconnect');
    assert.equal(stt.connected, false);
  });

  test(`${name}: a socket abandoned by disconnect() cannot drive callbacks later`, async () => {
    sockets.length = 0;
    const statuses = [];
    const stt = new Ctor('key', { onStatusChange: (s) => statuses.push(s) });
    await stt.connect();
    const old = sockets[0];
    old.open();
    assert.deepEqual(statuses, ['connected']);
    stt.disconnect();
    old.emit('close', 1006); // late event from the dead socket
    assert.deepEqual(statuses, ['connected'], 'stale close must not report disconnected for the replacement');
  });
}

test('Deepgram: an unexpected close while connected still reconnects', async (t) => {
  enableMockTimeout(t);
  sockets.length = 0;
  const stt = new DeepgramStreamingSTT('key', {});
  await stt.connect();
  sockets[0].open();
  sockets[0].close(1011);
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 2, 'server-side close should open a replacement socket');
  stt.disconnect();
});
