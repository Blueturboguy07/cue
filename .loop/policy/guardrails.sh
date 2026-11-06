#!/usr/bin/env bash
# guardrails.sh <base_sha> <head_sha> <policy_json> <pr_json_path>
#
# Static checks on a loop PR.  It only READS the PR (git diff, git show); it never runs PR code.
# <base_sha> is the merge-base of the PR and its base branch, so `git diff base head` is
# exactly what the PR changes.
#
# Environment
#   REPO_DIR        git checkout that contains both commits (default: .)
#   REPO            owner/name, for the label-actor lookup (gh api)
#   PR_NUMBER       pull request number
#   LABELED_NAME    label of the `labeled` event that started this run ('' otherwise)
#   LABELED_ACTOR   login that applied it (github.event.sender.login; only valid when the
#                   action is `labeled`, the workflow sets both or neither)
#   GH_TOKEN        token for `gh api` (read-only is enough)
#   GUARDRAILS_EVENTS_FILE  test hook: JSON lines {"l":label,"a":login} in place of `gh api`
#
# Output: one line per check, `CHECK <name>: PASS|FAIL <detail>`.  Exit 1 when any check fails.
# The script never prints a secret match, only the file and the pattern name.
set -uo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: guardrails.sh <base_sha> <head_sha> <policy_json> <pr_json_path>" >&2
  echo "CHECK usage: FAIL bad arguments"
  exit 1
fi
BASE_SHA=$1 HEAD_SHA=$2 POLICY_JSON=$3 PR_JSON=$4
REPO_DIR=${REPO_DIR:-.}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export BASE_SHA HEAD_SHA POLICY_JSON PR_JSON REPO_DIR
export REPO="${REPO:-}" PR_NUMBER="${PR_NUMBER:-}" LABELED_NAME="${LABELED_NAME:-}" LABELED_ACTOR="${LABELED_ACTOR:-}"

fail=0

# `python3 -I`: isolated mode.  Never import from the current directory, which may hold PR files.
out=$(python3 -I - <<'PY'
import fnmatch, json, os, re, subprocess, sys

E = os.environ
repo_dir, base, head = E["REPO_DIR"], E["BASE_SHA"], E["HEAD_SHA"]
results = []


def emit(name, ok, detail=""):
    results.append("CHECK %s: %s %s" % (name, "PASS" if ok else "FAIL", detail.strip()))


def git(*args, check=True):
    p = subprocess.run(["git", "-C", repo_dir, "-c", "core.quotepath=off", *args],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise RuntimeError("git %s: %s" % (" ".join(args[:2]), p.stderr.decode(errors="replace").strip()))
    return p.stdout


def glob_re(g):
    out, i = "", 0
    while i < len(g):
        if g.startswith("**/", i):
            out += "(?:.*/)?"; i += 3; continue
        if g.startswith("**", i):
            out += ".*"; i += 2; continue
        c = g[i]
        out += "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


try:
    policy = json.load(open(E["POLICY_JSON"]))
    pr = json.load(open(E["PR_JSON"]))
except Exception as e:
    print("CHECK inputs: FAIL cannot read policy or PR json: %s" % e)
    sys.exit(0)

max_files = int(policy.get("max_files", 12))
max_lines = int(policy.get("max_lines", 400))
humans = set(policy.get("humans", []))
forbidden = policy.get("forbidden_paths", [])
labels = {l["name"] if isinstance(l, dict) else l for l in pr.get("labels", [])}

# ---- changed files (renames split into delete + add so every path is judged)
try:
    raw = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", base, head).split(b"\0")
    changed = []
    for i in range(0, len(raw) - 1, 2):
        changed.append((raw[i].decode(), raw[i + 1].decode()))
    numstat = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, head).split(b"\0")
    lines_by_path = {}
    for rec in numstat:
        if not rec:
            continue
        a, d, path = rec.decode().split("\t", 2)
        lines_by_path[path] = 0 if a == "-" else int(a) + int(d)
except Exception as e:
    print("CHECK diff: FAIL cannot read the diff (%s)" % e)
    sys.exit(0)

paths = [p for _, p in changed]
loop_paths = [p for p in paths if p == ".loop" or p.startswith(".loop/")]
code_paths = [p for p in paths if p not in loop_paths]

# ---- size (.loop/** is the loop's own evidence and is not counted)
n_files = len(code_paths)
n_lines = sum(lines_by_path.get(p, 0) for p in code_paths)
emit("size", n_files <= max_files and n_lines <= max_lines,
     "%d files (max %d), %d lines (max %d), .loop/** not counted" % (n_files, max_files, n_lines, max_lines))

# ---- human labels
events_cache = []


def label_events():
    if events_cache:
        return events_cache[0]
    evs = []
    f = E.get("GUARDRAILS_EVENTS_FILE")
    if f:
        txt = open(f).read()
    else:
        if not E.get("REPO") or not E.get("PR_NUMBER"):
            raise RuntimeError("REPO or PR_NUMBER missing")
        p = subprocess.run(["gh", "api", "--paginate", "repos/%s/issues/%s/events" % (E["REPO"], E["PR_NUMBER"]),
                            "--jq", '.[] | select(.event=="labeled") | {l:.label.name,a:.actor.login}'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if p.returncode != 0:
            raise RuntimeError("gh api failed: %s" % p.stderr.strip())
        txt = p.stdout
    for ln in txt.splitlines():
        if ln.strip():
            evs.append(json.loads(ln))
    events_cache.append(evs)
    return evs


def human_label(name):
    """(ok, detail). ok only when the label is on the PR and a human applied it."""
    if name not in labels:
        return False, "label %s absent" % name
    if E.get("LABELED_NAME") == name and E.get("LABELED_ACTOR"):
        actor = E["LABELED_ACTOR"]; src = "labeled event"
    else:
        try:
            evs = [x for x in label_events() if x.get("l") == name]
        except Exception as e:
            return False, "cannot verify who applied %s (%s)" % (name, e)
        if not evs:
            return False, "no labeled event found for %s" % name
        actor = evs[-1].get("a"); src = "events API"
    if actor in humans:
        return True, "%s applied by %s (%s)" % (name, actor, src)
    return False, "%s applied by %s, not in policy.humans (%s)" % (name, actor, src)


# ---- workflows
wf = [p for p in paths if p.startswith(".github/workflows/")]
wf_ok = False
if not wf:
    emit("workflows", True, "no .github/workflows changes")
else:
    wf_ok, d = human_label("loop:policy")
    emit("workflows", wf_ok, "%d workflow file(s) changed (%s): %s" % (len(wf), ", ".join(wf[:3]), d))

# ---- dependency manifests and lockfiles
DEP = re.compile(r"^(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|Cargo\.lock|"
                 r"pyproject\.toml|uv\.lock|requirements[^/]*\.txt|Podfile[^/]*|Package\.resolved|go\.mod|go\.sum)$")
deps = [p for p in paths if DEP.match(p.rsplit("/", 1)[-1])]
if not deps:
    emit("dependencies", True, "no manifest or lockfile changes")
else:
    ok, d = human_label("loop:deps")
    emit("dependencies", ok, "%d manifest/lockfile(s) changed (%s): %s" % (len(deps), ", ".join(deps[:4]), d))

# ---- forbidden paths (the workflows glob is released by the human loop:policy label)
bad = []
for pat in forbidden:
    rx = glob_re(pat)
    if pat == ".github/workflows/**" and wf_ok:
        continue
    bad += [p for p in paths if rx.match(p)]
emit("forbidden-paths", not bad, ("touches " + ", ".join(sorted(set(bad))[:6])) if bad else "none of %d patterns match" % len(forbidden))

# ---- secrets in added lines, and .env files added
SECRET = [("sk-key", r"sk-[A-Za-z0-9]{20,}"), ("google-api-key", r"AIza[0-9A-Za-z_-]{30,}"),
          ("github-token", r"ghp_[A-Za-z0-9]{30,}"), ("github-pat", r"github_pat_"),
          ("aws-access-key", r"AKIA[0-9A-Z]{16}"), ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY"),
          ("slack-token", r"xox[baprs]-")]
SECRET = [(n, re.compile(r)) for n, r in SECRET]
hits, cur = [], None
try:
    diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", base, head).decode("utf-8", "replace")
    for ln in diff.splitlines():
        if ln.startswith("+++ "):
            cur = ln[6:] if ln.startswith("+++ b/") else None
        elif ln.startswith("+") and cur is not None:
            for n, rx in SECRET:
                if rx.search(ln):
                    hits.append("%s (%s)" % (cur, n))
    for st, p in changed:
        b = p.rsplit("/", 1)[-1]
        if st == "A" and (b == ".env" or (b.startswith(".env.") and not re.search(r"\.(example|sample|template)$", b))):
            hits.append("%s (.env file added)" % p)
    emit("secrets", not hits, ("; ".join(sorted(set(hits))[:6])) if hits else "no secret patterns in added lines")
except Exception as e:
    emit("secrets", False, "cannot scan (%s)" % e)

# ---- PR body trailers
body = pr.get("body") or ""
mt = re.findall(r"(?m)^Loop-Ticket:[ \t]*(\S+)[ \t]*$", body)
mb = re.findall(r"(?mi)^Publik-Break-Id:[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*$", body)
ticket = mt[-1] if mt else None
tok = bool(ticket and re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", ticket))
emit("trailers", bool(mt) and bool(mb) and tok,
     "Loop-Ticket %s, Publik-Break-Id %s" % (ticket if tok else ("invalid" if mt else "missing"), "ok" if mb else "missing or not a uuid"))

# ---- branch, fork
head_ref = pr.get("headRefName", "")
if "isCrossRepository" in pr:
    emit("same-repo", not pr["isCrossRepository"], "PR head is %s" % ("a fork" if pr["isCrossRepository"] else "in this repo"))
emit("branch-name", bool(tok) and head_ref == "loop/" + str(ticket), "head ref %r, expected loop/<ticket>" % head_ref)

# ---- .loop/<ticket>/ evidence: present, additions only
if not tok:
    emit("loop-dir", False, "no valid ticket, so no .loop/<ticket>/ to check")
else:
    prefix = ".loop/%s/" % ticket
    problems = []
    for st, p in changed:
        if p.startswith(".loop/") or p == ".loop":
            if st != "A":
                problems.append("%s %s (only additions allowed)" % ({"M": "modified", "D": "deleted"}.get(st, st), p))
            elif not p.startswith(prefix):
                problems.append("added outside %s: %s" % (prefix, p))
    for need in ("accept.sh", "ticket.json"):
        if subprocess.run(["git", "-C", repo_dir, "cat-file", "-e", "%s:%s%s" % (head, prefix, need)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            problems.append("missing %s%s" % (prefix, need))
    try:
        t = json.loads(git("show", "%s:%s" % (head, prefix + "ticket.json")).decode())
        miss = [k for k in ("key", "app_slug", "platform", "base_sha") if not t.get(k)]
        if miss:
            problems.append("ticket.json lacks " + ",".join(miss))
        if t.get("key") and t.get("key") != ticket:
            problems.append("ticket.json key %r differs from Loop-Ticket" % t.get("key"))
        if t.get("platform") and t["platform"] not in ("macos", "windows", "linux", "any"):
            problems.append("ticket.json platform %r invalid" % t["platform"])
        if t.get("base_sha") and not re.match(r"^[0-9a-f]{7,40}$", str(t["base_sha"])):
            problems.append("ticket.json base_sha is not a git sha")
        if "test_cmds" in t and not (isinstance(t["test_cmds"], list) and all(isinstance(x, str) for x in t["test_cmds"])):
            problems.append("ticket.json test_cmds is not a string list")
    except Exception as e:
        if not any(x.startswith("missing") and "ticket.json" in x for x in problems):
            problems.append("ticket.json unreadable (%s)" % e)
    emit("loop-dir", not problems, "; ".join(problems) if problems else "%s has accept.sh and ticket.json, .loop changes are additions only" % prefix)

print("\n".join(results))
PY
)
py_rc=$?
if [ "$py_rc" -ne 0 ] || [ -z "$out" ]; then
  echo "CHECK guardrails: FAIL internal error in the check script (exit $py_rc)"
  exit 1
fi
printf '%s\n' "$out"
# here-strings, not printf | grep -q: under pipefail a large output lets grep -q exit first, printf dies of
# SIGPIPE and the if reads false, which would miss a FAIL line (fail open).
if grep -q '^CHECK [^:]*: FAIL' <<<"$out"; then fail=1; fi

# ---- test weakening: fails closed.  Exit 0 pass, 1 weakening found, 2 could not decide.
tw=$(python3 -I "$HERE/test_weakening.py" "$BASE_SHA" "$HEAD_SHA" --repo "$REPO_DIR" 2>&1)
tw_rc=$?
if [ "$tw_rc" -eq 0 ] && grep -q '^CHECK test-weakening: PASS' <<<"$tw"; then
  printf '%s\n' "$tw"
else
  fail=1
  if grep -q '^CHECK test-weakening: FAIL' <<<"$tw"; then
    printf '%s\n' "$tw" | grep '^CHECK test-weakening:'
  else
    echo "CHECK test-weakening: FAIL checker exit $tw_rc without a verdict (fails closed)"
  fi
fi

exit "$fail"
