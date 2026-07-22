const assert = require('node:assert/strict');
const test = require('node:test');
const { pcmToWav, rms16 } = require('../src/wav');

test('wraps PCM samples in a valid mono 16-bit WAV container', () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);

  const wav = pcmToWav(pcm, 16000, 1);

  assert.equal(wav.length, 48);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('calculates RMS for 16-bit PCM and treats silence as zero', () => {
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(3, 0);
  pcm.writeInt16LE(4, 2);
  pcm.writeInt16LE(0, 4);

  assert.equal(rms16(Buffer.alloc(4)), 0);
  assert.ok(Math.abs(rms16(pcm) - Math.sqrt(25 / 3)) < 1e-12);
});
