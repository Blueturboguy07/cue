const SUPPORTED_BASE_URL_PROTOCOLS = new Set(['http:', 'https:']);
const OPTIONAL_API_KEY_PLACEHOLDER = 'not-required';

/**
 * Normalize and validate an OpenAI-compatible API base URL.
 *
 * Credentials and query fragments are rejected because the configured API key
 * is already sent through the Authorization header. Keeping secrets out of the
 * URL also avoids accidental disclosure through logs and error messages.
 *
 * @param {unknown} value Raw setting value.
 * @returns {string} A normalized URL without trailing slashes, or an empty string.
 */
function normalizeBaseUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';

  let parsedUrl;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error('Base URL must be a valid HTTP or HTTPS URL.');
  }

  if (!SUPPORTED_BASE_URL_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error('Base URL must use HTTP or HTTPS.');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Base URL must not contain embedded credentials.');
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('Base URL must not contain a query string or fragment.');
  }

  return parsedUrl.toString().replace(/\/+$/, '');
}

/**
 * Build constructor options for the OpenAI SDK when targeting a compatible API.
 * Local servers commonly require no API key, but the SDK requires a non-empty
 * value, so a non-secret placeholder is supplied only when the setting is blank.
 *
 * @param {unknown} apiKey Raw API key setting.
 * @param {unknown} baseUrl Raw base URL setting.
 * @returns {{apiKey: string, baseURL: string}} OpenAI SDK client options.
 */
function createCompatibleClientOptions(apiKey, baseUrl) {
  const baseURL = normalizeBaseUrl(baseUrl);
  if (!baseURL) {
    throw new Error('Set a Base URL for the Custom provider.');
  }

  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  return {
    apiKey: normalizedApiKey || OPTIONAL_API_KEY_PLACEHOLDER,
    baseURL
  };
}

module.exports = {
  OPTIONAL_API_KEY_PLACEHOLDER,
  createCompatibleClientOptions,
  normalizeBaseUrl
};
