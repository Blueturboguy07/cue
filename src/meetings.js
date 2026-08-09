// Meeting history + memory — local JSON-file persistence.
// Each meeting: { id, title, startedAt, endedAt, channels, transcript,
//   summary, actionItems, followUp, notes, context }
// Lightweight retrieval: returns only the last N summaries for memory injection,
// never the full transcript of every meeting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadMeetingsFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMeetingsFile(file, meetings) {
  try {
    fs.writeFileSync(file, JSON.stringify(meetings, null, 2));
    return true;
  } catch {
    return false;
  }
}

function createMeetingStore(opts = {}) {
  const file = opts.file;
  let meetings = file ? loadMeetingsFile(file) : [];

  return {
    file,
    list() { return meetings; },

    add() {
      const m = {
        id: newId(),
        title: 'Untitled meeting',
        startedAt: Date.now(),
        endedAt: null,
        transcript: [], // { channel, text, ts }
        summary: '',
        keyPoints: [],
        decisions: [],
        actionItems: [],
        followUp: '',
        context: ''
      };
      meetings.push(m);
      if (file) saveMeetingsFile(file, meetings);
      return m;
    },

    get(id) {
      return meetings.find((m) => m.id === id) || null;
    },

    update(id, patch) {
      const m = this.get(id);
      if (!m) return null;
      Object.assign(m, patch);
      if (file) saveMeetingsFile(file, meetings);
      return m;
    },

    addTurn(id, turn) {
      const m = this.get(id);
      if (!m) return null;
      m.transcript.push(turn);
      if (file) saveMeetingsFile(file, meetings);
      return m;
    },

    // Compact summaries of the most recent meetings (for memory injection).
    recentSummaries(n = 3) {
      return meetings
        .filter((m) => m.summary)
        .slice(-n)
        .map((m) => ({ id: m.id, title: m.title, startedAt: m.startedAt, summary: m.summary }));
    },

    search(q) {
      if (!q) return [];
      const needle = q.toLowerCase();
      return meetings
        .map((m) => ({ m, score: scoreMeeting(m, needle) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.m)
        .slice(0, 20);
    },

    remove(id) {
      const before = meetings.length;
      meetings = meetings.filter((m) => m.id !== id);
      if (file) saveMeetingsFile(file, meetings);
      return meetings.length < before;
    },

    all() { return meetings.slice(); }
  };
}

function scoreMeeting(m, needle) {
  let score = 0;
  // followUp arrives as an array from parseNotes but as a string from older
  // records, so flatten before matching rather than assuming either shape.
  const fields = [m.title, m.summary, ...[].concat(m.followUp || []), ...m.actionItems, ...m.transcript.map((t) => t.text)];
  for (const f of fields) {
    if (typeof f !== 'string' || !f) continue;
    if (f.toLowerCase().includes(needle)) score += 1;
  }
  return score;
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { loadMeetingsFile, saveMeetingsFile, createMeetingStore };