// Builds the response Electron expects from setDisplayMediaRequestHandler.
//
// Streams.audio accepts 'loopback', 'loopbackWithMute', or a WebFrameMain, and
// loopback capture of system audio is supported on Windows only. Anything else
// makes getDisplayMedia reject before the request reaches the OS, so the choice
// lives here where it can be tested without booting Electron.
function buildDisplayMediaRequest({ sources, platform }) {
  if (!sources || !sources.length) return null;

  const request = { video: sources[0] };
  if (platform === 'win32') request.audio = 'loopback';
  return request;
}

module.exports = { buildDisplayMediaRequest };
