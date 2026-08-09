// Structured meeting notes — turns a transcript into summary / key points /
// decisions / action items / follow-up. Pure + deterministic parts are
// unit-testable; the LLM call lives in main.js.

// Build the user turn that asks the model to write structured notes.
function buildNotesPrompt(transcript) {
  const who = (t) => (t.channel === 'them' ? 'Them' : 'You');
  const lines = transcript.map((t) => who(t) + ': ' + t.text).join('\n');
  return (
    'Meeting transcript:\n' +
    (lines || '(empty)') +
    '\n\nWrite concise meeting notes with EXACTLY these five headings, each ' +
    'heading alone on its own line:\n' +
    'Meeting Summary:\n' +
    'Key Points:\n' +
    'Decisions:\n' +
    'Action Items:\n' +
    'Follow-Up:\n' +
    'Use a hyphen at the start of each bullet. Keep Summary to 2–3 sentences.'
  );
}

const HEADERS = [
  ['summary', /^meeting summary\s*:?\s*$/i],
  ['keyPoints', /^key points\s*:?\s*$/i],
  ['decisions', /^decisions\s*:?\s*$/i],
  ['actionItems', /^action items\s*:?\s*$/i],
  ['followUp', /^follow[- ]up\s*:?\s*$/i]
];

// Parse the model's notes blob into a structured record. Forgiving: filters
// bullets, collapses duplicates, and falls back to dumping unrecognized text
// into the summary if the model ignored the requested layout.
function parseNotes(text) {
  const out = { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  if (!text || !text.trim()) return out;

  const lines = text.split(/\r?\n/);
  let cur = null;
  const buckets = { summary: [], keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  for (const raw of lines) {
    const line = raw.trim();
    const matched = HEADERS.find(([, re]) => re.test(line));
    if (matched) { cur = matched[0]; continue; }
    if (!cur) continue;
    if (!line) { cur = null; continue; } // blank line ends a section
    buckets[cur].push(line);
  }
  for (const [k, arr] of Object.entries(buckets)) {
    if (k === 'summary') { out.summary = arr.join(' ').trim(); continue; }
    out[k] = arr.map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\[[ x]\]\s*/, '').replace(/^[0-9]+[.)]\s*/, '').trim()).filter(Boolean);
  }

  // If the model didn't use any heading and nothing was captured, fall back.
  const anything = Object.values(buckets).some((a) => a.length);
  if (!anything && text.trim()) out.summary = text.trim();
  return out;
}

module.exports = { buildNotesPrompt, parseNotes };