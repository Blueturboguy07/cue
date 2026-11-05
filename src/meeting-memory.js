// Meeting memory — wires the meeting store (meetings.js) and notes (notes.js)
// into the live transcript so cue remembers what was said:
//   • every transcript turn is persisted as it lands (survives a crash/restart)
//   • an interrupted meeting is resumed on the next launch if it is recent
//   • when listening stops, notes (summary / decisions / action items) are
//     written with the LLM and stored; earlier-ended meetings without notes
//     are caught up in the background on launch
//   • the last few meeting summaries are offered as a "previous meetings"
//     block for prompts
// All I/O and the LLM are injected so the lifecycle is unit-testable.

const { buildNotesPrompt, parseNotes } = require('./notes');

const NOTES_SYSTEM =
  'You are cue, writing private meeting notes for the user ("You") from a transcript of a conversation with ' +
  'another party ("Them"). Be factual and specific: keep names, numbers, dates and commitments exactly as said; ' +
  'never invent details that are not in the transcript. Write in clear English.';

const DEFAULTS = {
  resumeWindowMs: 30 * 60 * 1000, // an open meeting whose last turn is older than this is treated as over
  minTurnsForNotes: 4,             // fewer than this is a false start, not a meeting worth notes
  maxMeetings: 50,                 // kept on disk; oldest are pruned
  memoryCount: 3                   // summaries offered to prompts
};

function createMeetingMemory(opts) {
  const { store, llmFactory } = opts;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  // Called when a refused answer is asked once more on another model (src/llm.js).
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : undefined;
  const cfg = { ...DEFAULTS, ...opts };
  let current = null;        // the meeting the live transcript is being written to
  let notesTurnCount = 0;    // transcript length when notes were last written for `current`
  let notesInFlight = null;
  let notesInFlightFor = null; // the meeting the running notes call is for
  let notesInFlightTurns = 0; // and how many of its turns it was given
  let notesAgain = null;     // one more call, queued after the running one

  function lastTurnTs(m) {
    return m.transcript.length ? m.transcript[m.transcript.length - 1].ts : m.startedAt;
  }

  function titleFor(summary, startedAt) {
    const first = (summary || '').split(/(?<=[.!?])\s/)[0].trim();
    if (first) return first.length > 60 ? first.slice(0, 57).trimEnd() + '…' : first;
    return 'Meeting on ' + new Date(startedAt).toLocaleDateString();
  }

  // Write notes for a meeting with the LLM. Resolves to the parsed notes
  // (with `turns`: how many turns they were written from), or null when
  // there is nothing to do (too short, no usable provider, failure).
  async function writeNotes(m) {
    if (!m || m.transcript.length < cfg.minTurnsForNotes) return null;
    const llm = llmFactory();
    if (!llm || !llm.ready) return null;
    // Turns that come while the call runs are not in these notes.
    const turns = m.transcript.length;
    try {
      const text = await llm.stream({
        system: NOTES_SYSTEM,
        turns: [{ role: 'user', text: buildNotesPrompt(m.transcript) }],
        // Stored notes never carry the chat answer's "(Cut off: …)" note: a
        // cut is trimmed and ends with "…", as slide captions do.
        lengthCut: 'ellipsis',
        onToken: () => {},
        onRetry
      });
      const notes = parseNotes(text);
      if (!notes.summary) return null;
      store.update(m.id, { ...notes, title: titleFor(notes.summary, m.startedAt), notesAt: now(), notesTurns: turns });
      log(`notes written for meeting ${m.id} (${turns} turns)`);
      return { ...notes, turns };
    } catch (e) {
      log(`notes failed for meeting ${m.id}: ${e && e.message}`);
      return null;
    }
  }

  function refresh() {
    if (!current) return Promise.resolve(null);
    if (notesInFlight) {
      if (current === notesInFlightFor && current.transcript.length <= notesInFlightTurns) return notesInFlight;
      if (!notesAgain) notesAgain = notesInFlight.catch(() => null).then(() => { notesAgain = null; return refresh(); });
      return notesAgain;
    }
    if (current.transcript.length === notesTurnCount) return Promise.resolve(null);
    const m = current;
    const count = m.transcript.length;
    notesInFlightFor = m;
    notesInFlightTurns = count;
    notesInFlight = writeNotes(m).then((notes) => { if (notes && current === m) notesTurnCount = count; return notes; })
      .finally(() => { notesInFlight = null; });
    return notesInFlight;
  }

  return {
    get current() { return current; },

    // On launch: pick up a meeting that was still open (no endedAt) if its last
    // turn is recent enough to plausibly be the same conversation. Returns the
    // turns to restore into the live transcript ([] when nothing to resume).
    resumeOpen() {
      const all = store.all();
      const last = all[all.length - 1];
      if (!last || last.endedAt) return [];
      if (now() - lastTurnTs(last) <= cfg.resumeWindowMs) {
        current = last;
        notesTurnCount = last.notesTurns || 0;
        log(`resumed meeting ${last.id} (${last.transcript.length} turns)`);
        return last.transcript.slice();
      }
      store.update(last.id, { endedAt: lastTurnTs(last) }); // stale: close it, notes get caught up
      return [];
    },

    // Every live transcript turn lands here. A meeting opens on the first
    // turn; a long silence since the previous turn means the last one is over.
    onTurn(turn) {
      if (current && now() - lastTurnTs(current) > cfg.resumeWindowMs) this.end();
      if (!current) {
        current = store.add();
        notesTurnCount = 0;
        store.prune(cfg.maxMeetings);
        log(`meeting ${current.id} started`);
      }
      store.addTurn(current.id, turn);
    },

    // Listening stopped (or the user asked): refresh the notes for the current
    // meeting if there is anything new. Background — callers need not await.
    // The notes it resolves to hold every turn there was when it was called:
    // while a call runs that was given fewer turns (Stop, Start and Stop
    // again within seconds, 0.2.12 smoke), one more call follows it.
    refreshNotes() {
      return refresh();
    },

    // Close the current meeting (transcript cleared, quit, or a long gap).
    // Returns the notes promise so a caller can wait for them if it wants to.
    end() {
      if (!current) return Promise.resolve(null);
      const m = current;
      store.update(m.id, { endedAt: now() });
      const notes = this.refreshNotes();
      current = null;
      notesTurnCount = 0;
      log(`meeting ${m.id} ended (${m.transcript.length} turns)`);
      return notes;
    },

    // Launch-time catch-up: meetings that ended without notes (quit, crash).
    async catchUp() {
      const pending = store.all().filter((m) => m.endedAt && !m.summary && m.transcript.length >= cfg.minTurnsForNotes);
      let written = 0;
      for (const m of pending) { if (await writeNotes(m)) written++; } // sequential: one provider call at a time
      return written;
    },

    // "Previous meetings" context for prompts — summaries only, never full
    // transcripts, and never the meeting that is happening right now.
    memoryBlock() {
      const items = store.recentSummaries(cfg.memoryCount + 1)
        .filter((m) => !current || m.id !== current.id)
        .slice(-cfg.memoryCount);
      if (!items.length) return null;
      const lines = items.map((m) => `- ${new Date(m.startedAt).toLocaleDateString()} — ${m.title}: ${m.summary}`);
      return 'Previous meetings (for background only; the live transcript is what matters now):\n' + lines.join('\n');
    },

    flush() { store.flush(); }
  };
}

module.exports = { createMeetingMemory, NOTES_SYSTEM };
