/* Shared by the overlay and permissions window. No sensitive content is shown
   until the protection notice has been painted and main accepts this load. */
(function () {
  const cue = window.cue;
  const notice = document.getElementById('privacy-notice');
  const hide = document.getElementById('window-hide-btn');
  const pause = document.getElementById('pause-btn');
  let state = null, revision = 0;

  function paint(next) {
    state = next;
    const protection = next.protection || {};
    const reasons = {
      'debug-override': 'disabled by CUE_NO_PROTECT',
      'windows-build': 'unsupported on this Windows build',
      'windows-remote-session': 'disabled in this remote session',
      'windows-session-unknown': 'disabled because this Windows session is unknown',
      linux: 'unsupported on Linux', platform: 'unsupported on this platform',
      'api-error': 'unavailable because the OS request failed'
    };
    const message = protection.status === 'requested'
      ? 'Screen-share protection requested; receiver visibility is unverified.'
      : 'Screen-share protection ' + (reasons[protection.reason] || 'not ready') + '. Cue may appear in captures.';
    notice.textContent = (next.paused ? (next.recoverable ? 'Privacy pause is active. Restore does not restart listening. ' : 'Privacy pause is active. Restore shortcut unavailable; Cue stays visible. ') : '') + message;
    if (next.paused && !pause) {
      const resume = document.createElement('button');
      resume.textContent = 'Resume';
      resume.addEventListener('click', () => act(() => cue.privacyResume()));
      notice.appendChild(resume);
    }
    if (hide) {
      hide.disabled = !next.recoverable;
      hide.title = next.recoverable ? 'Hide window; restore with Ctrl/⌘+Shift+Space. Listening continues.' : 'Restore shortcut unavailable; hiding is disabled.';
    }
    if (pause) pause.textContent = next.paused ? 'Resume' : 'Privacy pause';
  }

  async function act(operation) {
    try { await operation(); }
    catch (_) { notice.textContent = 'This privacy action could not finish. Use Ctrl/⌘+Shift+Space to restore Cue.'; }
  }
  if (hide) hide.addEventListener('click', () => act(() => cue.hideWindow()));
  if (pause) pause.addEventListener('click', () => act(() => state?.paused ? cue.privacyResume() : cue.privacyPause()));
  cue.on('privacy:state', (next) => { revision++; paint(next); });
  const requestedRevision = revision;
  cue.privacyState().then((next) => {
    if (requestedRevision === revision) paint(next);
    // The token must come from this particular renderer load, even when a
    // newer pause notification superseded its state snapshot.
    cue.windowReady(next.windowToken);
  }).catch(() => { notice.textContent = 'Privacy status could not be checked. Cue remains hidden; restart to try again.'; });
})();
