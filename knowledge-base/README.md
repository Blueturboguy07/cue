# knowledge-base/

Local, grep-able Markdown that cue retrieves from at answer time. Everything in
here except this README and `slite-sources.json` is gitignored: it is internal
Miter content and is rebuilt by the sync scripts.

```
knowledge-base/
  slite/<topic>/**.md        # scripts/sync-slite.js  — Slite notes, one topic per root note
  miter-guides/**.md         # scripts/sync-miter-guides.js — github.com/Miter-HR/miter-guides (dashboard/)
  .miter-guides-repo/        # blobless sparse clone the guides script pulls from
```

## Syncing

```bash
# Miter guides (uses your existing git/gh GitHub auth)
node scripts/sync-miter-guides.js

# Slite — needs a workspace API key (Slite → Settings → API)
export SLITE_API_KEY=...
node scripts/sync-slite.js --search "discovery questions"     # find root note ids
#   -> paste ids into slite-sources.json
node scripts/sync-slite.js
```

Each file carries a frontmatter header (`title`, `source`, `url`, `breadcrumb`)
that the loader uses for ranking and for citing the source in the prompt. You
can also drop any hand-written `.md` in here; it is indexed on the next reload.

## How cue uses it

`src/knowledge-base.js` loads every `.md` at startup, splits it into
heading-bounded chunks (~1,800 chars), and builds a BM25 index in memory
(~0.5 s for 5,000 chunks). On every Assist / Say / Ask / Follow-up / Recap
request, `main.js` turns the last few transcript turns plus the typed question
into a query, pulls the top 6 chunks (≤ 7,000 chars), and prepends them to the
system prompt as an `=== Internal knowledge base ===` block with source titles
and URLs. The folder is re-checked every 30 s, so a sync run is picked up
without restarting the app. Set `knowledgeBase: false` in `cue-data.json` to
turn it off.
