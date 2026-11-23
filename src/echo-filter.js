// Drops "you" lines that are the meeting audio heard again through the mic.
//
// With laptop speakers (no headphones) the microphone picks up the other
// side of the call, so every sentence of theirs came back as a second line
// from "you" (smoke test: "Walk me through a project where you used a large
// language" was stored once as them and once as you). That duplicate fed the
// prompts as if the user had said the interviewer's question, and the
// renderer read the "you" line as the user starting to answer and cleared
// the question from the input box.
//
// A "you" line is held for `holdMs` (the meeting audio's copy of the same
// words can come back a moment later), then dropped when most of its words
// were just said on the "them" channel. "Them" lines are never held.
// Dependencies (clock, timers, publish) are injected so this is unit-testable.

const DEFAULTS = {
  holdMs: 2500,     // how long a "you" line waits for the "them" copy of it
  windowMs: 8000,   // "them" lines this close in time can be the source of an echo
  shortWindowMs: 3000, // a one- or two-word line must match a "them" line this close
  minOverlap: 0.6   // share of the "you" words heard on "them" that makes it an echo
};

function words(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

function createEchoFilter(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = cfg.now || Date.now;
  const setTimer = cfg.setTimeout || setTimeout;
  const clearTimer = cfg.clearTimeout || clearTimeout;
  const publish = cfg.publish;
  const onDrop = cfg.onDrop || (() => {});
  let recentThem = []; // { ts, words: Set }
  const held = new Map(); // timer -> settle(), for "you" lines waiting

  function remember(turn) {
    const t = now();
    recentThem.push({ ts: turn.ts || t, words: new Set(words(turn.text)) });
    recentThem = recentThem.filter((r) => t - r.ts <= cfg.windowMs * 2);
  }

  function isEcho(turn) {
    const w = words(turn.text);
    if (!w.length) return false;
    const ts = turn.ts || now();
    const near = recentThem.filter((r) => Math.abs(r.ts - ts) <= cfg.windowMs);
    if (!near.length) return false;
    if (w.length < 3) {
      // "Yes." is too short to judge by overlap with a whole sentence: only a
      // "them" line said at nearly the same moment that holds all of it.
      return near.some((r) => Math.abs(r.ts - ts) <= cfg.shortWindowMs && w.every((x) => r.words.has(x)));
    }
    const heard = new Set();
    for (const r of near) for (const x of r.words) heard.add(x);
    const shared = w.filter((x) => heard.has(x)).length;
    return shared / w.length >= cfg.minOverlap;
  }

  return {
    // A finished transcript line from either channel.
    offer(turn, extra) {
      if (!turn || !turn.text) return;
      if (turn.channel !== 'you') {
        remember(turn);
        publish(turn, extra);
        return;
      }
      if (isEcho(turn)) { onDrop(turn); return; }
      const settle = () => {
        held.delete(timer);
        if (isEcho(turn)) onDrop(turn);
        else publish(turn, extra);
      };
      const timer = setTimer(settle, cfg.holdMs);
      held.set(timer, settle);
    },
    // Publish every held line now (session stopped: nothing waits past it).
    flush() {
      for (const [timer, settle] of [...held]) { clearTimer(timer); settle(); }
    },
    _isEcho: isEcho
  };
}

module.exports = { createEchoFilter, words, DEFAULTS };
