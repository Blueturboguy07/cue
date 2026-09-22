// knowledge-base.js — local retrieval over knowledge-base/**/*.md.
//
// The knowledge base is a directory of Markdown files (Slite mirrors, Miter
// guides, anything else dropped in) each with an optional YAML-ish frontmatter
// header (title / source / url / breadcrumb). At load time every file is split
// into heading-bounded chunks and indexed with BM25. At prompt time the recent
// transcript + typed question become the query, the top chunks are formatted
// into a context block, and main.js prepends that block to the system prompt.
//
// Pure Node — no Electron imports — so it is unit-testable and reusable from
// scripts (e.g. `node -e "require('./src/knowledge-base').init(dir); ..."`).
const fs = require('fs');
const path = require('path');

const MAX_CHUNK_CHARS = 1800;     // roughly 400-450 tokens
const MIN_CHUNK_CHARS = 200;      // merge tiny trailing sections into the previous chunk
const DEFAULT_LIMIT = 6;          // chunks per answer
const DEFAULT_BUDGET_CHARS = 7000; // total retrieved text per answer
const RELOAD_CHECK_MS = 30_000;   // cheapest possible "did the folder change?" poll

const STOP = new Set(('a an and are as at be but by for from has have how i if in into is it its of on or that the this to ' +
  'was we what when where which who why will with you your our they them their there here can could should would do does did ' +
  'me my so than then these those too very just about also any all more most some such only other over up down out off').split(' '));

function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
    let t = raw.replace(/^[.#+]+|[.#+]+$/g, '');
    if (t.length < 2 || STOP.has(t)) continue;
    // light stemming: plural / gerund / past — good enough for lexical recall
    if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
    else if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    else if (t.length > 5 && t.endsWith('ed')) t = t.slice(0, -2);
    out.push(t);
  }
  return out;
}

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    meta[kv[1]] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

// Split on headings; merge short sections; hard-split anything over the cap on paragraph boundaries.
function chunkMarkdown(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      if (cur.lines.join('\n').trim()) sections.push(cur);
      cur = { heading: line.replace(/^#+\s*/, '').trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('\n').trim()) sections.push(cur);

  const chunks = [];
  for (const s of sections) {
    const text = s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    if (text.length <= MAX_CHUNK_CHARS) {
      const prev = chunks[chunks.length - 1];
      if (prev && text.length < MIN_CHUNK_CHARS && prev.text.length + text.length < MAX_CHUNK_CHARS) {
        prev.text += `\n\n${s.heading ? '### ' + s.heading + '\n' : ''}${text}`;
      } else chunks.push({ heading: s.heading, text });
      continue;
    }
    let buf = '';
    for (const para of text.split(/\n\n+/)) {
      if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) { chunks.push({ heading: s.heading, text: buf }); buf = ''; }
      if (para.length > MAX_CHUNK_CHARS) {
        for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS) chunks.push({ heading: s.heading, text: para.slice(i, i + MAX_CHUNK_CHARS) });
      } else buf = buf ? buf + '\n\n' + para : para;
    }
    if (buf) chunks.push({ heading: s.heading, text: buf });
  }
  return chunks;
}

let ROOT_SKIP_DIR = null;
function walkMd(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    if (dir === ROOT_SKIP_DIR && ent.name.toLowerCase() === 'readme.md') continue; // the folder's own docs, not corpus
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(p, acc);
    else if (ent.isFile() && /\.(md|markdown|txt)$/i.test(ent.name)) acc.push(p);
  }
  return acc;
}

// Cheap fingerprint of the folder: file count + newest mtime. Not a hash of
// contents, but catches every sync run and every hand edit.
function fingerprint(dir) {
  const files = walkMd(dir);
  let newest = 0;
  for (const f of files) { try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch { /* ignore */ } }
  return `${files.length}:${Math.round(newest)}`;
}

class KnowledgeBase {
  constructor() { this.dir = null; this.docs = []; this.chunks = []; this.index = new Map(); this.df = new Map(); this.avgLen = 0; this.fp = ''; this.lastCheck = 0; this.loadedAt = 0; }

  init(dir) { this.dir = dir; this.reload(); return this; }

  reload() {
    if (!this.dir) return;
    ROOT_SKIP_DIR = this.dir;
    const files = walkMd(this.dir);
    const docs = [];
    const chunks = [];
    for (const file of files) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      const rel = path.relative(this.dir, file).replace(/\\/g, '/');
      const title = meta.title || (/^#\s+(.+)$/m.exec(body) || [])[1] || path.basename(file, path.extname(file));
      const doc = { id: docs.length, file: rel, title, source: meta.source || rel.split('/')[0], url: meta.url || '', breadcrumb: meta.breadcrumb || meta.topic || '' };
      docs.push(doc);
      for (const c of chunkMarkdown(body)) {
        chunks.push({ id: chunks.length, doc: doc.id, heading: c.heading, text: c.text, tokens: null, len: 0 });
      }
    }
    // BM25 index. Title/heading/breadcrumb tokens are added to each chunk so a
    // query like "kickoff" matches every chunk of the kickoff doc, not just the
    // paragraph that happens to repeat the word.
    const index = new Map();
    const df = new Map();
    let totalLen = 0;
    for (const ch of chunks) {
      const d = docs[ch.doc];
      const fieldTokens = tokenize(`${d.title} ${d.title} ${ch.heading} ${d.breadcrumb}`);
      const toks = tokenize(ch.text).concat(fieldTokens);
      ch.len = toks.length;
      totalLen += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, n] of tf) {
        if (!index.has(t)) index.set(t, []);
        index.get(t).push([ch.id, n]);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    this.docs = docs; this.chunks = chunks; this.index = index; this.df = df;
    this.avgLen = chunks.length ? totalLen / chunks.length : 0;
    this.fp = fingerprint(this.dir);
    this.lastCheck = Date.now();
    this.loadedAt = Date.now();
  }

  reloadIfChanged() {
    if (!this.dir || Date.now() - this.lastCheck < RELOAD_CHECK_MS) return false;
    this.lastCheck = Date.now();
    if (fingerprint(this.dir) === this.fp) return false;
    this.reload();
    return true;
  }

  get ready() { return this.chunks.length > 0; }

  stats() {
    const bySource = {};
    for (const d of this.docs) bySource[d.source] = (bySource[d.source] || 0) + 1;
    return { dir: this.dir, docs: this.docs.length, chunks: this.chunks.length, bySource, loadedAt: this.loadedAt };
  }

  search(query, { limit = DEFAULT_LIMIT, perDoc = 2 } = {}) {
    this.reloadIfChanged();
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !this.chunks.length) return [];
    const N = this.chunks.length, k1 = 1.4, b = 0.75;
    const scores = new Map();
    for (const t of qTokens) {
      const postings = this.index.get(t);
      if (!postings) continue;
      const idf = Math.log(1 + (N - postings.length + 0.5) / (postings.length + 0.5));
      for (const [cid, tf] of postings) {
        const len = this.chunks[cid].len;
        const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / this.avgLen));
        scores.set(cid, (scores.get(cid) || 0) + s);
      }
    }
    const ranked = [...scores.entries()].sort((a, b2) => b2[1] - a[1]);
    const out = [];
    const perDocCount = new Map();
    for (const [cid, score] of ranked) {
      const ch = this.chunks[cid];
      const n = perDocCount.get(ch.doc) || 0;
      if (n >= perDoc) continue;
      perDocCount.set(ch.doc, n + 1);
      out.push({ score, chunk: ch, doc: this.docs[ch.doc] });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Query text from live state: what they just asked, what you typed, a little of what you said.
  static queryFromState({ transcript = [], userText = '' } = {}) {
    const them = transcript.filter((t) => t.channel === 'them').slice(-4).map((t) => t.text);
    const you = transcript.filter((t) => t.channel === 'you').slice(-2).map((t) => t.text);
    return [userText, ...them, ...you].filter(Boolean).join('\n').slice(-2500);
  }

  // The block main.js prepends to the system prompt. null when nothing relevant.
  buildKnowledgeBlock(query, { limit = DEFAULT_LIMIT, budgetChars = DEFAULT_BUDGET_CHARS, minScore = 1.0 } = {}) {
    const hits = this.search(query, { limit }).filter((h) => h.score >= minScore);
    if (!hits.length) return null;
    const parts = [];
    let used = 0;
    for (const h of hits) {
      const where = [h.doc.title, h.chunk.heading].filter(Boolean).join(' › ');
      const head = `[${h.doc.source}] ${where}${h.doc.url ? ` (${h.doc.url})` : ''}`;
      const text = h.chunk.text;
      if (used + head.length + text.length > budgetChars) {
        const room = budgetChars - used - head.length - 1;
        if (room > 300) parts.push(head + '\n' + text.slice(0, room) + '…');
        break;
      }
      parts.push(head + '\n' + text);
      used += head.length + text.length + 2;
    }
    return '=== Internal knowledge base (retrieved for this question) ===\n' +
      'The excerpts below come from Miter\'s internal docs (Slite) and the public Miter Guides. ' +
      'Prefer them over general knowledge when they are relevant; quote specifics (names, numbers, steps). ' +
      'If they do not answer the question, ignore them rather than forcing a fit.\n\n' +
      parts.join('\n\n---\n\n');
  }
}

const shared = new KnowledgeBase();

module.exports = {
  KnowledgeBase,
  tokenize,
  chunkMarkdown,
  parseFrontmatter,
  queryFromState: KnowledgeBase.queryFromState,
  init: (dir) => shared.init(dir),
  reload: () => shared.reload(),
  search: (q, o) => shared.search(q, o),
  buildKnowledgeBlock: (q, o) => shared.buildKnowledgeBlock(q, o),
  stats: () => shared.stats(),
  isReady: () => shared.ready
};
