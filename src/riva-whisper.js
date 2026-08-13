// NVIDIA NIM speech transcription (Riva ASR gRPC) using the hosted whisper-large-v3 model.
// Runs on NVIDIA's cloud GPUs instead of local CPU, avoiding local Whisper's
// unusably slow large-v3 inference time on machines without a capable GPU.
// Requires an NVCF function-id alongside the API key (from the model's "API"
// tab on build.nvidia.com/openai/whisper-large-v3).
const path = require('path');

const RIVA_ENDPOINT = 'grpc.nvcf.nvidia.com:443';
const RIVA_MODEL = 'whisper-large-v3-multi-asr-offline-asr-bls-ensemble';

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const grpc = require('@grpc/grpc-js');
  const protoLoader = require('@grpc/proto-loader');
  const protoDir = path.join(__dirname, 'riva-proto');
  const packageDef = protoLoader.loadSync(path.join(protoDir, 'riva', 'proto', 'riva_asr.proto'), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    includeDirs: [protoDir]
  });
  const proto = grpc.loadPackageDefinition(packageDef).nvidia.riva.asr;
  cachedClient = { proto, grpc };
  return cachedClient;
}

function transcribeNvidiaWhisper(apiKey, functionId, wav) {
  const { proto, grpc } = getClient();
  const pcm = wav.subarray(44); // strip the 44-byte WAV header written by pcmToWav; Riva wants raw LINEAR_PCM

  const metaCallCreds = grpc.credentials.createFromMetadataGenerator((params, cb) => {
    const md = new grpc.Metadata();
    md.set('authorization', 'Bearer ' + apiKey);
    md.set('function-id', functionId);
    cb(null, md);
  });
  const channelCreds = grpc.credentials.combineChannelCredentials(
    grpc.credentials.createSsl(),
    metaCallCreds
  );
  const client = new proto.RivaSpeechRecognition(RIVA_ENDPOINT, channelCreds);

  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + 20);

  return new Promise((resolve, reject) => {
    client.Recognize({
      config: {
        encoding: 'LINEAR_PCM',
        sample_rate_hertz: 16000,
        language_code: 'en-US',
        max_alternatives: 1,
        model: RIVA_MODEL
      },
      audio: pcm
    }, { deadline }, (err, resp) => {
      client.close();
      if (err) return reject(err);
      const alt = resp.results && resp.results[0] && resp.results[0].alternatives && resp.results[0].alternatives[0];
      resolve((alt && alt.transcript || '').trim());
    });
  });
}

module.exports = { transcribeNvidiaWhisper };
