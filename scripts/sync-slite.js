#!/usr/bin/env node
// Mirror selected Slite notes (and all their children) into knowledge-base/slite/.
//
// Config: knowledge-base/slite-sources.json — one root note per topic
// (assets, discovery questions, customer references, kickoff process,
// competitive discovery, ...). Each root is walked recursively via the Slite
// REST API and every note is written as Markdown with a small frontmatter
// header the knowledge-base loader reads.
//
//   SLITE_API_KEY=... node scripts/sync-slite.js
//   SLITE_API_KEY=... node scripts/sync-slite.js --search "discovery questions"   # find note ids
//
// Get a key: Slite → Settings → API (workspace admin). Docs: https://developers.slite.com
const fs = require('fs');
const path = require('path');

const API = process.env.SLITE_API_BASE || 'https://api.slite.com/v1';
const KEY = process.env.SLITE_API_KEY;
const ROOT = path.join(__dirname, '..', 'knowledge-base');
const OUT_DIR = path.join(ROOT, 'slite');
const SOURCES = path.join(ROOT, 'slite-sources.json');
const CONCURRENCY = 4;

if (!KEY) {
  console.error('SLITE_API_KEY is not set. Create one in Slite → Settings → API, then rerun.');
  process.exit(1);
}

async function slite(pathname, params) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'x-slite-api-key': KEY, accept: 'application/json' } });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      throw new Error(`Slite ${res.status} ${res.statusText} for ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
}

// GET /notes/{id}?format=md → { id, title, content (markdown), url, updatedAt, parentNoteId, ... }
const getNote = (id) => slite(`/notes/${encodeURIComponent(id)}`, { format: 'md' });

// GET /notes/{id}/children → { notes: [{id, title, ...}], nextCursor? } — paginated.
async function listChildren(id) {
  const out = [];
  let cursor;
  do {
    const page = await slite(`/notes/${encodeURIComponent(id)}/children`, { cursor });
    const items = page.notes || page.items || page.hits || [];
    out.push(...items);
    cursor = page.nextCursor || page.cursor || null;
  } while (cursor);
  return out;
}

async function search(query) {
  const page = await slite('/search-notes', { query, hitsPerPage: 20 });
  const hits = page.hits || page.notes || [];
  for (const h of hits) console.log(`${h.id}\t${h.title || '(untitled)'}\t${h.url || ''}`);
  if (!hits.length) console.log('no results');
}

function slug(s) {
  return String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

// Depth-first walk; returns [{ note, trail: [title, ...] }]
async function walk(id, trail, acc, seen) {
  if (seen.has(id)) return acc;
  seen.add(id);
  const note = await getNote(id);
  const here = [...trail, note.title || id];
  acc.push({ note, trail: here });
  const children = await listChildren(id);
  await mapLimit(children, CONCURRENCY, (c) => walk(c.id, here, acc, seen));
  return acc;
}

function writeNote(label, { note, trail }, seenPaths) {
  const dir = path.join(OUT_DIR, label, ...trail.slice(1, -1).map(slug));
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, slug(note.title) + '.md');
  if (seenPaths.has(dest)) dest = path.join(dir, `${slug(note.title)}-${note.id}.md`);
  seenPaths.add(dest);
  const header = [
    '---',
    `title: ${JSON.stringify(note.title || '')}`,
    'source: slite',
    `topic: ${label}`,
    `id: ${note.id}`,
    `url: ${JSON.stringify(note.url || `https://miter.slite.com/app/docs/${note.id}`)}`,
    `breadcrumb: ${JSON.stringify(trail.join(' > '))}`,
    `updated: ${note.updatedAt || ''}`,
    `synced: ${new Date().toISOString()}`,
    '---',
    ''
  ].join('\n');
  const body = typeof note.content === 'string' ? note.content : (note.markdown || '');
  fs.writeFileSync(dest, header + `# ${note.title || ''}\n\n` + body.trim() + '\n');
}

async function main() {
  const si = process.argv.indexOf('--search');
  if (si !== -1) return search(process.argv.slice(si + 1).join(' '));

  const { roots } = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const usable = roots.filter((r) => r.id && r.id !== 'REPLACE_ME');
  if (!usable.length) {
    console.error(`No root note ids configured in ${path.relative(process.cwd(), SOURCES)}. Use --search "<title>" to find them.`);
    process.exit(1);
  }
  let total = 0;
  for (const root of usable) {
    process.stdout.write(`${root.label}: walking ${root.id} ... `);
    const notes = await walk(root.id, [], [], new Set());
    fs.rmSync(path.join(OUT_DIR, root.label), { recursive: true, force: true });
    const seenPaths = new Set();
    for (const n of notes) writeNote(root.label, n, seenPaths);
    console.log(`${notes.length} notes`);
    total += notes.length;
  }
  console.log(`wrote ${total} Slite notes to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
