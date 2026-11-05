// Cross-talk: without headphones the mic hears the speakers (and a caller's mic
// can send your voice back), so one sentence lands on both channels a moment
// apart. The later copy is the echo; dropping it keeps "Them" questions real.

const ECHO_WINDOW_MS = 4000;
const ECHO_OVERLAP = 0.6;

const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

function isCrossTalkEcho(turn, transcript) {
  const w = words(turn.text);
  if (!w.length) return false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    if (turn.ts - t.ts > ECHO_WINDOW_MS) break;
    if (t.channel === turn.channel) continue;
    const other = new Set(words(t.text));
    if (w.filter((x) => other.has(x)).length / w.length >= ECHO_OVERLAP) return true;
  }
  return false;
}

module.exports = { isCrossTalkEcho };
