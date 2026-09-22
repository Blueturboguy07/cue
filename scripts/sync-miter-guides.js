#!/usr/bin/env node
// Pull the Miter help-center Markdown into knowledge-base/miter-guides/.
//
// Source: github.com/Miter-HR/miter-guides — the repo GitBook git-syncs the
// public guides from. Only `dashboard/**/*.md` is copied (the ~3 MB of prose);
// the ~600 MB of images/video is never downloaded thanks to a blobless sparse
// clone. Re-running does a `git pull` and re-mirrors, so it is safe to run
// often. Auth: whatever `git` already uses for github.com (gh auth setup-git).
//
//   node scripts/sync-miter-guides.js            # sync
//   node scripts/sync-miter-guides.js --clean    # wipe the mirror first
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'https://github.com/Miter-HR/miter-guides.git';
const SUBDIR = 'dashboard';
const ROOT = path.join(__dirname, '..', 'knowledge-base');
const CLONE_DIR = path.join(ROOT, '.miter-guides-repo');
const OUT_DIR = path.join(ROOT, 'miter-guides');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function ensureClone() {
  if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) {
    fs.mkdirSync(ROOT, { recursive: true });
    console.log('cloning', REPO, '(blobless, sparse)');
    git(['clone', '--filter=blob:none', '--sparse', '--depth', '1', REPO, CLONE_DIR], ROOT);
    git(['sparse-checkout', 'set', '--no-cone', `${SUBDIR}/**/*.md`, `${SUBDIR}/*.md`], CLONE_DIR);
  } else {
    console.log('updating clone');
    git(['pull', '--ff-only', '--depth', '1'], CLONE_DIR);
  }
  return git(['rev-parse', 'HEAD'], CLONE_DIR);
}

function walkMd(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

function titleFrom(md, fallback) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  if (fm) {
    const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]);
    if (t) return t[1];
  }
  const h1 = /^#\s+(.+)$/m.exec(md);
  return h1 ? h1[1].trim() : fallback;
}

function mirror(sha) {
  if (process.argv.includes('--clean')) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const srcRoot = path.join(CLONE_DIR, SUBDIR);
  const files = walkMd(srcRoot);
  const seen = new Set();
  let written = 0;
  for (const src of files) {
    const rel = path.relative(srcRoot, src);
    if (/(^|\/)SUMMARY\.md$/.test(rel)) continue; // GitBook table of contents, pure link noise
    const md = fs.readFileSync(src, 'utf8');
    const title = titleFrom(md, path.basename(rel, '.md'));
    const guidePath = '/' + rel.replace(/\\/g, '/').replace(/(^|\/)README\.md$/, '').replace(/\.md$/, '');
    const header = [
      '---',
      `title: ${JSON.stringify(title)}`,
      'source: miter-guides',
      `path: ${JSON.stringify(rel.replace(/\\/g, '/'))}`,
      `url: ${JSON.stringify('https://guides.miter.com' + guidePath)}`,
      `synced: ${new Date().toISOString()}`,
      `commit: ${sha}`,
      '---',
      ''
    ].join('\n');
    const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const dest = path.join(OUT_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, header + body);
    seen.add(dest);
    written++;
  }
  // Remove pages deleted upstream.
  for (const stale of walkMd(OUT_DIR)) if (!seen.has(stale)) fs.unlinkSync(stale);
  console.log(`wrote ${written} guide pages to ${path.relative(process.cwd(), OUT_DIR)} @ ${sha.slice(0, 8)}`);
}

mirror(ensureClone());
