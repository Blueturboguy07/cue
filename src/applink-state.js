// What Iris is allowed to know about cue.
//
// Split out from applink.js so it can be tested without Electron, and because
// it is the file where a privacy mistake would actually happen. Everything
// else in the link is plumbing; this decides what leaves the process.
//
// The rule: **counts, never content.**
//
//   • The transcript is a recording of a conversation other people are part of
//     and did not agree to share. A turn count and a timestamp let Iris tell
//     "transcription is working" from "transcription is silently dead", which
//     is all it needs. The words never leave.
//   • The résumé is the user's own history, and its presence is the only
//     diagnostic fact about it.
//   • Whether an API key is set is a diagnosis. The key is a liability.

function describeState({ state, transcript, settings, sttDisabled, shortcuts, windowAlive }) {
  const keys = (settings && settings.apiKeys) || {};
  const turns = transcript || [];
  return {
    capturing: state.capturing,
    busy: state.busy,
    transcribing: { you: state.transcribing.you, them: state.transcribing.them },

    // The single most useful field here. When this is true cue looks alive and
    // silently is not, and until now nothing outside the process could see it.
    transcriptionDisabled: !!sttDisabled,

    transcriptTurns: turns.length,
    lastTurnAt: turns.length ? new Date(turns[turns.length - 1].ts).toISOString() : null,

    provider: settings.provider,
    smart: !!settings.smart,
    models: (settings.models && settings.models[settings.provider]) || null,
    hasKey: Object.fromEntries(Object.keys(keys).map((name) => [name, !!keys[name]])),
    hasResumeContext: !!(settings.resumeContext && settings.resumeContext.length),

    // A global shortcut another app registered first is a classic silent break:
    // the user presses the key, nothing happens, and cue never knew.
    shortcuts: shortcuts || {},

    windowAlive: !!windowAlive,
  };
}

/**
 * Word a consent sheet from what can be proven, not from what was claimed.
 *
 * On the Node transport cue cannot read the peer's credentials, so the caller's
 * name is a claim. A sheet that presents a claim as a fact is worse than no
 * sheet at all, so this returns the hedged wording unless the peer's code
 * signature was actually verified.
 */
function consentCopy(request) {
  const trusted = request.verification === 'code-signature';
  const who = trusted ? request.callerName : `A program identifying itself as “${request.callerName}”`;
  const action = request.scope === 'action';

  return {
    trusted,
    message: action ? `${who} wants to control cue.` : `${who} wants to see what cue is doing.`,
    detail:
      (action
        ? 'It would be able to start and stop listening. '
        : 'It would be able to read cue’s status, recent warnings and errors — never your transcript, your résumé or your API keys. ') +
      (trusted
        ? 'Its code signature has been verified.'
        : 'cue cannot verify what this program really is; anything running under your account could make the same claim.') +
      '\n\nYou can change this later in cue’s settings.',
    allowLabel: action ? 'Allow control' : 'Allow',
  };
}

module.exports = { describeState, consentCopy };
