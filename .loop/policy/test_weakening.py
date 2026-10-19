#!/usr/bin/env python3
"""Test-weakening check for loop PRs.  Standard library only.

Usage
  test_weakening.py <base> <head> [--repo DIR]   compare two git revisions
  test_weakening.py --dirs BEFORE AFTER          compare two plain directories (no git)

Output (one line, plus one indented line per reason)
  CHECK test-weakening: PASS
  CHECK test-weakening: FAIL <reason>; <reason>

Exit codes
  0  no weakening found
  1  weakening found
  2  the check could not decide (parse uncertainty, git error, binary test code).
     This is a FAIL for the workflow: the check fails closed.

What counts as weakening
  1. A test file is deleted, or renamed to a path that no longer looks like a test.
  2. A test file is emptied (only whitespace left).
  3. The net number of an assertion/test token falls, summed over ALL test files of
     the change.  Summing means that moving a test from one file to another passes.
     Tokens inside comments and strings are not counted, so commenting an assertion
     out is a removal.
  4. A skip marker is added (.skip( .only( xit( xdescribe( #[ignore] todo!( ...).
"""
import difflib
import fnmatch
import hashlib
import os
import re
import subprocess
import sys

# --------------------------------------------------------------------------- globs
TEST_GLOBS = [
    "**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.py",
    "**/tests/**", "**/__tests__/**", "test/*.test.js",
]


def glob_to_regex(glob):
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if glob.startswith("**/", i):
            out += "(?:.*/)?"; i += 3; continue
        if glob.startswith("**", i):
            out += ".*"; i += 2; continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


_TEST_RES = [glob_to_regex(g) for g in TEST_GLOBS]


def is_test_path(path):
    return any(r.match(path) for r in _TEST_RES)


CODE_EXTS = {
    ".js": "c", ".jsx": "c", ".ts": "c", ".tsx": "c", ".mjs": "c", ".cjs": "c", ".mts": "c", ".cts": "c",
    ".rs": "rust", ".swift": "c", ".kt": "c", ".java": "c", ".go": "c", ".c": "c", ".cc": "c", ".cpp": "c",
    ".py": "py",
}


def lang_of(path):
    return CODE_EXTS.get(os.path.splitext(path)[1].lower())


# --------------------------------------------------------------------------- tokens
# kind -> regex.  Counted on text with comments and string contents removed.
TOKENS = {
    "expect(": re.compile(r"\bexpect\s*\("),
    "assert": re.compile(r"\bassert\b(?!\s*!)"),
    "assert!": re.compile(r"\bassert\s*!\s*\("),
    "assert_eq!": re.compile(r"\bassert_(?:eq|ne)\s*!\s*\("),
    "assertX(": re.compile(r"\bassert[A-Z]\w*\s*\("),
    "#[test]": re.compile(r"#\[\s*(?:\w+::)*test\s*\]"),
    "#[cfg(test)]": re.compile(r"#\[\s*cfg\s*\(\s*test\s*\)\s*\]"),
    "it(": re.compile(r"\bit\s*\("),
    "test(": re.compile(r"\btest\s*\("),
    "t.is(": re.compile(r"\bt\.is\s*\("),
    "XCTAssert": re.compile(r"\bXCTAssert\w*\s*\("),
    "def test_": re.compile(r"(?m)^[ \t]*(?:async[ \t]+)?def[ \t]+test_\w*"),
}
# Rust files that are not test files: only these kinds are counted outside #[cfg(test)] bodies.
RUST_OUTSIDE_KINDS = {"#[test]", "#[cfg(test)]"}

SKIPS = {
    ".skip(": re.compile(r"\.skip\s*\("),
    ".only(": re.compile(r"\.only\s*\("),
    "xit(": re.compile(r"\bxit\s*\("),
    "xtest(": re.compile(r"\bxtest\s*\("),
    "xdescribe(": re.compile(r"\bxdescribe\s*\("),
    ".todo(": re.compile(r"\.todo\s*\("),
    "skip: true": re.compile(r"\bskip\s*:\s*(?:true|['\"`])"),
    "#[ignore]": re.compile(r"#\[\s*ignore\b"),
    "todo!(": re.compile(r"\btodo\s*!\s*\("),
    "pytest.mark.skip": re.compile(r"\bpytest\.mark\.(?:skip|skipif|xfail)\b"),
    "pytest.skip(": re.compile(r"\bpytest\.(?:skip|xfail)\s*\("),
    "@unittest.skip": re.compile(r"@\s*unittest\.skip\w*"),
}


class Uncertain(Exception):
    pass


def strip_code(text, lang):
    """Remove comments and string contents.  Newlines are kept.
    Raises Uncertain when a block comment or multi-line string is never closed."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        two = text[i:i + 2]
        if lang == "py":
            if c == "#":
                while i < n and text[i] != "\n":
                    i += 1
                continue
            for q in ('"""', "'''"):
                if text.startswith(q, i):
                    j = text.find(q, i + 3)
                    if j < 0:
                        raise Uncertain("unterminated triple-quoted string")
                    out.append(q + q + "\n" * text.count("\n", i, j))
                    i = j + 3
                    break
            else:
                if c in "\"'":
                    j = i + 1
                    while j < n and text[j] != c and text[j] != "\n":
                        j += 2 if text[j] == "\\" else 1
                    out.append(c + c)
                    i = j + 1 if j < n and text[j] == c else j
                else:
                    out.append(c); i += 1
            continue
        # C-like and rust
        if two == "//":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if two == "/*":
            depth, j = 1, i + 2
            while j < n and depth:
                if lang == "rust" and text.startswith("/*", j):
                    depth += 1; j += 2
                elif text.startswith("*/", j):
                    depth -= 1; j += 2
                else:
                    j += 1
            if depth:
                raise Uncertain("unterminated block comment")
            out.append(" " + "\n" * text.count("\n", i, j))
            i = j
            continue
        if c == "`" and lang == "c":
            j = text.find("`", i + 1)
            if j < 0:
                raise Uncertain("unterminated template literal")
            out.append("``" + "\n" * text.count("\n", i, j))
            i = j + 1
            continue
        if c == '"' or (c == "'" and lang == "c"):
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            out.append(c + c)
            i = j + 1 if j < n and text[j] == c else j
            continue
        if c == "'" and lang == "rust":
            m = re.match(r"'(?:\\.[^']*|[^\\'])'", text[i:i + 12])
            if m:
                out.append("''"); i += m.end()
            else:
                out.append(c); i += 1  # lifetime
            continue
        out.append(c); i += 1
    return "".join(out)


def cfg_test_bodies(stripped):
    """Text inside the braces that follow each #[cfg(test)]."""
    bodies = []
    for m in TOKENS["#[cfg(test)]"].finditer(stripped):
        j = stripped.find("{", m.end())
        if j < 0:
            continue
        depth, k = 1, j + 1
        while k < len(stripped) and depth:
            if stripped[k] == "{":
                depth += 1
            elif stripped[k] == "}":
                depth -= 1
            k += 1
        if depth:
            raise Uncertain("unbalanced braces after #[cfg(test)]")
        bodies.append(stripped[j + 1:k - 1])
    return bodies


def count(text, path, is_test):
    """Return (token counts, skip counts, blank) for one file version, or None for text we do not read."""
    lang = lang_of(path)
    if text is None:
        return {}, {}, False
    blank = not text.strip()
    if lang is None:
        return {}, {}, blank
    s = strip_code(text, lang)
    tok = {k: 0 for k in TOKENS}
    if lang == "rust" and not is_test:
        region = "\n".join(cfg_test_bodies(s))
        for k in RUST_OUTSIDE_KINDS:
            tok[k] = len(TOKENS[k].findall(s))
        for k, rx in TOKENS.items():
            if k not in RUST_OUTSIDE_KINDS:
                tok[k] = len(rx.findall(region))
    else:
        for k, rx in TOKENS.items():
            tok[k] = len(rx.findall(s))
    sk = {k: len(rx.findall(s)) for k, rx in SKIPS.items()}
    return tok, sk, blank


# --------------------------------------------------------------------------- sources
class Change:
    def __init__(self, status, old, new, before, after):
        self.status, self.old, self.new, self.before, self.after = status, old, new, before, after


def read_text(data, path):
    if data is None:
        return None
    if b"\0" in data[:8192]:
        if lang_of(path):
            raise Uncertain("binary content in code file " + path)
        return ""  # opaque binary (image, db): only deletion matters
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        if lang_of(path):
            raise Uncertain("non-UTF-8 code file " + path)
        return ""


def git(args, repo, raw=False):
    p = subprocess.run(["git", "-C", repo, "-c", "core.quotepath=off"] + args,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise Uncertain("git %s failed: %s" % (" ".join(args[:2]), p.stderr.decode(errors="replace").strip()))
    return p.stdout


def changes_from_git(base, head, repo):
    raw = git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M60%", base, head], repo)
    parts = raw.split(b"\0")
    out, i = [], 0
    while i < len(parts) and parts[i]:
        st = parts[i].decode()
        if st[0] in "RC":
            old, new = parts[i + 1].decode(), parts[i + 2].decode()
            i += 3
        else:
            old = new = parts[i + 1].decode()
            i += 2
        status = st[0]
        if status == "C":
            status = "A"; old = None
        before = None if status == "A" else read_text(git(["show", "%s:%s" % (base, old)], repo), old)
        after = None if status == "D" else read_text(git(["show", "%s:%s" % (head, new)], repo), new)
        out.append(Change(status, None if status == "A" else old, None if status == "D" else new, before, after))
    return out


def walk(root):
    files = {}
    for d, _, names in os.walk(root):
        for nm in names:
            full = os.path.join(d, nm)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel.startswith(".git/"):
                continue
            with open(full, "rb") as f:
                files[rel] = f.read()
    return files


def changes_from_dirs(before_dir, after_dir):
    a, b = walk(before_dir), walk(after_dir)
    changes = []
    removed = sorted(set(a) - set(b))
    added = sorted(set(b) - set(a))
    for p in sorted(set(a) & set(b)):
        if a[p] != b[p]:
            changes.append(Change("M", p, p, read_text(a[p], p), read_text(b[p], p)))
    # pair removed with added: identical bytes first, then similar text (>= 60%)
    pool = list(added)
    for r in removed:
        match = None
        h = hashlib.sha1(a[r]).digest()
        for ad in pool:
            if hashlib.sha1(b[ad]).digest() == h:
                match = ad; break
        if match is None and len(a[r]) < 200000:
            best = 0.6
            for ad in pool:
                if len(b[ad]) < 200000:
                    ratio = difflib.SequenceMatcher(None, a[r], b[ad]).quick_ratio()
                    if ratio >= best and difflib.SequenceMatcher(None, a[r], b[ad]).ratio() >= 0.6:
                        best, match = ratio, ad
        if match is not None:
            pool.remove(match)
            changes.append(Change("R", r, match, read_text(a[r], r), read_text(b[match], match)))
        else:
            changes.append(Change("D", r, None, read_text(a[r], r), None))
    for ad in pool:
        changes.append(Change("A", None, ad, None, read_text(b[ad], ad)))
    return changes


# --------------------------------------------------------------------------- analysis
def analyse(changes):
    reasons = []
    net = {k: 0 for k in TOKENS}
    where = {k: [] for k in TOKENS}
    for ch in changes:
        old_t = ch.old is not None and is_test_path(ch.old)
        new_t = ch.new is not None and is_test_path(ch.new)
        lang = lang_of(ch.new or ch.old)
        rust_src = lang == "rust"
        if ch.status == "D" and old_t:
            reasons.append("test file deleted: %s" % ch.old)
        if ch.status == "R" and old_t and not new_t:
            reasons.append("test file renamed away from test paths: %s -> %s" % (ch.old, ch.new))
        if new_t and ch.after is not None and not ch.after.strip() and (ch.before is None or ch.before.strip()):
            if ch.status != "A":
                reasons.append("test file emptied: %s" % ch.new)
        # tokens are read from every test file and from every Rust file (unit tests live in src/)
        tracked_old = old_t or (rust_src and ch.old is not None)
        tracked_new = new_t or (rust_src and ch.new is not None)
        if not (tracked_old or tracked_new):
            continue
        tb = count(ch.before, ch.old, old_t) if tracked_old else ({}, {}, False)
        ta = count(ch.after, ch.new, new_t) if tracked_new else ({}, {}, False)
        for k in TOKENS:
            delta = ta[0].get(k, 0) - tb[0].get(k, 0)
            net[k] += delta
            if delta:
                where[k].append("%s %+d" % (ch.new or ch.old, delta))
        for k in SKIPS:
            added = ta[1].get(k, 0) - tb[1].get(k, 0)
            if added > 0:
                reasons.append("%s added x%d in %s" % (k, added, ch.new))
    for k, v in net.items():
        if v < 0:
            reasons.append("net %d of '%s' across test files (%s)" % (v, k, ", ".join(where[k])))
    return reasons


def report(reasons, code):
    if not reasons:
        print("CHECK test-weakening: PASS")
        return 0
    print("CHECK test-weakening: FAIL " + "; ".join(reasons))
    return code


def main(argv):
    try:
        if len(argv) >= 3 and argv[0] == "--dirs":
            changes = changes_from_dirs(argv[1], argv[2])
        else:
            repo = "."
            if "--repo" in argv:
                k = argv.index("--repo")
                repo = argv[k + 1]
                argv = argv[:k] + argv[k + 2:]
            if len(argv) != 2:
                print(__doc__)
                print("CHECK test-weakening: FAIL bad arguments (check fails closed)")
                return 2
            changes = changes_from_git(argv[0], argv[1], repo)
        reasons = analyse(changes)
        return report(reasons, 1)
    except Uncertain as e:
        return report(["cannot decide: %s" % e], 2)
    except Exception as e:  # fail closed on anything unexpected
        return report(["cannot decide: unexpected %s: %s" % (type(e).__name__, e)], 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
