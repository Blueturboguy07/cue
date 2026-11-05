const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { UtteranceBatcher, BYTES_PER_SECOND } = require('../src/publik-stt-batcher');

const win = (ms) => Buffer.alloc(Math.round((ms / 1000) * BYTES_PER_SECOND), 7); // one ~900 ms voiced window
// A steady DC level is "steady noise" to the adaptive silence level after 3 s;
// floorRatio 0 keeps the fixed gate for the tests of the other rules.

test('voiced windows are held; a pause after them sends the whole utterance', () => {
  let t = 10000;
  const b = new UtteranceBatcher({ now: () => t });
  assert.equal(b.push(win(900)), null);
  assert.equal(b.push(win(900)), null);
  assert.equal(b.push(win(900)), null);
  assert.equal(b.pendingMs(), 2700);
  const out = b.push(null); // 900 ms of silence: a pause
  assert.ok(out);
  assert.equal(out.length, win(900).length * 3 + win(300).length, 'the speech and 300 ms of the pause');
  assert.equal(b.pendingMs(), 0);
  assert.equal(b.push(null), null, 'silence with nothing pending sends nothing');
});

test('a long stretch without a pause is cut at maxMs', () => {
  let t = 0;
  const b = new UtteranceBatcher({ maxMs: 8000, floorRatio: 0, now: () => t });
  let sent = null;
  for (let i = 0; i < 10 && !sent; i++) { t += 900; sent = b.push(win(900)); }
  assert.ok(sent, 'sent once 8 s were pending');
  assert.ok(sent.length >= 7.9 * BYTES_PER_SECOND && sent.length <= 8 * BYTES_PER_SECOND);
});

test('short utterances wait for minGapMs since the last send on that channel', () => {
  let t = 100000;
  const b = new UtteranceBatcher({ minGapMs: 5000, now: () => t });
  b.push(win(900)); b.push(null); assert.ok(b.push(null)); // "Yes." + 1.8 s of silence: sent at t=100000
  t += 900; b.push(win(900));
  t += 900; b.push(null);
  t += 900; assert.equal(b.push(null), null, 'ready, but only 2.7 s since the last send: wait');
  t += 900; assert.equal(b.push(null), null, '3.6 s: wait');
  t += 900; assert.equal(b.push(null), null, '4.5 s: wait');
  t += 900; const later = b.push(null);
  assert.ok(later, 'sent once 5.4 s had passed');
});

test('rate bound: two channels talking in short bursts for a minute stay under 60 requests', () => {
  let t = 0;
  const you = new UtteranceBatcher({ now: () => t });
  const them = new UtteranceBatcher({ now: () => t });
  let sends = 0;
  // Worst case for the old loop: speech, pause, speech, pause ... every 900 ms tick, both channels.
  for (let tick = 0; tick < 67; tick++) {
    t += 900;
    const voiced = tick % 2 === 0 ? win(900) : null;
    if (you.push(voiced)) sends += 1;
    if (them.push(voiced)) sends += 1;
  }
  assert.ok(sends <= 50, `sent ${sends} requests in one minute`);
  assert.ok(sends >= 20, `still transcribes (${sends} requests)`);
});

test('reset drops pending audio (capture stopped)', () => {
  const b = new UtteranceBatcher();
  b.push(win(900));
  b.reset();
  assert.equal(b.pendingMs(), 0);
  assert.equal(b.push(null), null);
});

test('main.js batches publik transcription and keeps listening through a passing publik error', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /const viaPublik = stt\.providers\[0\] === publik\.PUBLIK_PROVIDER;/);
  // While a request is in flight the window still goes into the batcher (feed), nothing is sent.
  assert.match(src, /if \(viaPublik\) \{\n(?:    \/\/[^\n]*\n)+    if \(busy\) \{ publikSttBatchers\[channel\]\.feed\(windowPcm\); return; \}\n    pcm = publikSttBatchers\[channel\]\.push\(windowPcm\);/);
  assert.match(src, /publikSttBatchers\.you\.reset\(\); publikSttBatchers\.them\.reset\(\);/);
  const start = src.indexOf('function handleSttError(err, settings)');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /const passing = isPassingSttError\(err\);/);
  assert.match(src, /function isPassingSttError\(err\) \{\n  return Boolean\(err\) && \(err\.status === 429 \|\| !err\.status \|\| err\.status >= 500\);\n\}/);
  assert.ok(body.indexOf('const passing') < body.indexOf('sttDisabled = true'), 'a passing publik error never switches transcription off');
});
