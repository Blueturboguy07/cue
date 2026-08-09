const test = require('node:test');
const assert = require('node:assert/strict');

const { createSTT } = require('../src/stt');

test('keeps Custom chat credentials separate from speech-to-text providers', async () => {
  const speechToText = createSTT({
    apiKeys: {
      custom: 'gateway-token'
    }
  });

  assert.equal(speechToText.available, false);
  assert.deepEqual(speechToText.providers, []);
  assert.deepEqual(await speechToText.transcribe(Buffer.alloc(6400)), { text: '' });
});
