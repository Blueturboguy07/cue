const DEFAULT_MODEL_ID = 'base.en';
const STANDARD_MODEL_REPOSITORY = 'ggerganov/whisper.cpp';
const TINYDIARIZE_MODEL_REPOSITORY = 'akashmjn/tinydiarize-whisper.cpp';

/**
 * Models published by whisper.cpp's official download script. Hashes and byte
 * counts come from each repository's Git LFS metadata and are intentionally
 * pinned so a corrupted or replaced download cannot be loaded.
 */
const MODEL_ARTIFACTS = Object.freeze([
  ['tiny', 77691713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'],
  ['tiny.en', 77704715, '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'],
  ['tiny-q5_1', 32152673, '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7'],
  ['tiny.en-q5_1', 32166155, 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b'],
  ['tiny-q8_0', 43537433, 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca'],
  ['base', 147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'],
  ['base.en', 147964211, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'],
  ['base-q5_1', 59707625, '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'],
  ['base.en-q5_1', 59721011, '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f'],
  ['base-q8_0', 81768585, 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9'],
  ['small', 487601967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'],
  ['small.en', 487614201, 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'],
  ['small.en-tdrz', 487614184, 'ceac3ec06d1d98ef71aec665283564631055fd6129b79d8e1be4f9cc33cc54b4'],
  ['small-q5_1', 190085487, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'],
  ['small.en-q5_1', 190098681, 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30'],
  ['small-q8_0', 264464607, '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f'],
  ['medium', 1533763059, '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'],
  ['medium.en', 1533774781, 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356'],
  ['medium-q5_0', 539212467, '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f'],
  ['medium.en-q5_0', 539225533, '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0'],
  ['medium-q8_0', 823369779, '42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502'],
  ['large-v1', 3094623691, '7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d'],
  ['large-v2', 3094623691, '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487'],
  ['large-v2-q5_0', 1080732091, '3a214837221e4530dbc1fe8d734f302af393eb30bd0ed046042ebf4baf70f6f2'],
  ['large-v2-q8_0', 1656129691, 'fef54e6d898246a65c8285bfa83bd1807e27fadf54d5d4e81754c47634737e8c'],
  ['large-v3', 3095033483, '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'],
  ['large-v3-q5_0', 1081140203, 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1'],
  ['large-v3-turbo', 1624555275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'],
  ['large-v3-turbo-q5_0', 574041195, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'],
  ['large-v3-turbo-q8_0', 874188075, '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1']
]);

function getFamily(modelId) {
  if (modelId.startsWith('large-v3-turbo')) return 'large-v3-turbo';
  if (modelId.startsWith('large')) return 'large';
  return modelId.split(/[.-]/)[0];
}

function getQuantization(modelId) {
  const match = modelId.match(/-(q\d+_\d+)$/);
  return match ? match[1].toUpperCase() : 'Full precision';
}

function getHardwareTier(family) {
  if (family === 'tiny') return 'Lightest';
  if (family === 'base') return 'Light';
  if (family === 'small') return 'Balanced';
  if (family === 'medium') return 'Heavy';
  return 'Very heavy';
}

function buildArtifact([id, bytes, sha256]) {
  const repository = id === 'small.en-tdrz'
    ? TINYDIARIZE_MODEL_REPOSITORY
    : STANDARD_MODEL_REPOSITORY;
  const filename = `ggml-${id}.bin`;
  const family = getFamily(id);

  return Object.freeze({
    id,
    label: id,
    filename,
    bytes,
    sha256,
    url: `https://huggingface.co/${repository}/resolve/main/${filename}`,
    englishOnly: id.includes('.en'),
    tinydiarize: id.endsWith('-tdrz'),
    quantization: getQuantization(id),
    hardwareTier: getHardwareTier(family),
    recommended: id === DEFAULT_MODEL_ID
  });
}

const WHISPER_MODELS = Object.freeze(MODEL_ARTIFACTS.map(buildArtifact));
const MODEL_BY_ID = new Map(WHISPER_MODELS.map((model) => [model.id, model]));

/** Return a trusted model descriptor or fail before touching the filesystem. */
function requireWhisperModel(modelId) {
  const model = MODEL_BY_ID.get(modelId);
  if (!model) throw new Error(`Unsupported Whisper model: ${modelId}`);
  return model;
}

module.exports = {
  DEFAULT_MODEL_ID,
  WHISPER_MODELS,
  requireWhisperModel
};
