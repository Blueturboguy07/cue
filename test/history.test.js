const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../src/history');

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('history: no folder until the first message; then dated folder + chat.json + PNGs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-hist-'));
  history.init(tmp);
  const base = path.join(tmp, 'history');
  assert.equal(fs.existsSync(base), false, 'nothing created on init');

  const dir = history.append({ kind: 'qa', mode: 'ask', question: 'what is this?', answer: 'a thing', images: [PNG, PNG] });
  assert.ok(dir && dir.startsWith(base));
  assert.equal(path.basename(dir), history.dayKey(), 'folder named by date');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'));
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].kind, 'qa');
  assert.equal(data.entries[0].question, 'what is this?');
  assert.equal(data.entries[0].images.length, 2, 'two screenshots recorded');
  for (const name of data.entries[0].images) {
    assert.match(name, /^shot-\d{6}-\d\.png$/);
    assert.ok(fs.existsSync(path.join(dir, name)), 'PNG file exists: ' + name);
  }

  history.append({ kind: 'transcript', channel: 'them', text: 'hello there' });
  const data2 = JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'));
  assert.equal(data2.entries.length, 2, 'appended, not overwritten');
  assert.equal(data2.entries[1].channel, 'them');
  assert.ok(!fs.existsSync(path.join(dir, 'chat.json.tmp')), 'atomic write leaves no temp');

  assert.equal(history.clearToday(), true);
  assert.equal(fs.existsSync(dir), false, "Clear History wipes today's folder");
  fs.rmSync(tmp, { recursive: true, force: true });
});
