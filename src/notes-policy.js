const { createHash } = require('node:crypto');
const publik = require('./publik');

// Approval belongs to the recipient selected when a meeting begins. Stored
// history must never inherit permission to send to a newly selected provider.
function notesDestination(settings) {
  if (settings.automaticNotes !== true) return null;
  const provider = settings.provider;
  if (!provider) return null;
  const endpoint = {
    custom: settings.baseUrl,
    anthropic: settings.anthropicBaseUrl,
    azure: settings.azureEndpoint,
    ollama: settings.apiKeys?.ollama || 'http://localhost:11434',
    publik: settings.publik?.baseUrl || publik.DEFAULT_BASE_URL,
    minimax: settings.minimaxRegion || 'global_en'
  }[provider] || '';
  // Custom URLs can themselves contain secrets; persist only a fingerprint.
  return provider + ':' + createHash('sha256').update(String(endpoint)).digest('hex');
}

module.exports = { notesDestination };
