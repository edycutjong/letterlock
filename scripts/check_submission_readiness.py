#!/usr/bin/env python3
"""Submission readiness: a checklist of what a judge opens first, and exit code 1 while anything fails.

  pnpm readiness              python3 scripts/check_submission_readiness.py
  pnpm readiness --online     also fetch the live app, every external link in README.md and DEMO.md, and the code
                              of both directories over JSON-RPC

Checks (FAIL blocks a submission, WARN is worth a look):
  docs         README.md and DEMO.md exist and carry the links a judge needs: the live app (the SDK's rpId host), a
               video, the mainnet directory on an explorer, mainnet transactions, the reproduce commands, and links to
               DEMO.md, docs/SPEC.md, bench/RESULTS.md and LICENSE; every relative link resolves; every p50/p95/p99
               figure in them is one bench/results.json holds
  placeholders no TODO, TBD, FIXME, XXX, lorem ipsum, youtu.be/xxx-style video links, or a bare 0x... / 0x… outside code,
               in any file the repository will publish (tracked, or untracked and not ignored)
  deployments  deployments/143.json and 10143.json exist, name a verified directory, and match the SDK's DEPLOYMENTS
  bench        bench/results.json exists, is newer than the last commit that changed the SDK's runtime code
               (packages/letterlock/src, packages/letterlock/package.json: the paths scripts/lib/git.ts names), was
               measured on that commit, and bench/RESULTS.md was written from it
  fixtures     fixtures/envelopes.json exists; a mainnet seed run is recorded (WARN until one is)
  license      LICENSE at the root
  public repo  no CLAUDE.md, AGENTS.md or .claude/, no .env file, no private key or PEM block, and no name of a
               private planning note (read from the folder next to the repository, never spelled out here)
Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve()
SDK_RUNTIME_PATHS = ["packages/letterlock/src", "packages/letterlock/package.json"]
EXPLORERS = ("monadvision.com", "monadscan.com")
SKIP_DIRS = ("contracts/lib/", "fixtures/", "node_modules/")
SKIP_FILES = {"pnpm-lock.yaml", "bench/results.json"}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".mp4", ".mov", ".webm", ".zip", ".svg"}

results: list[tuple[str, str, str, str]] = []  # (section, status, title, detail)


def record(section: str, status: str, title: str, detail: str = "") -> None:
    results.append((section, status, title, detail))


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def publishable_files() -> list[str]:
    """Every file the repository will publish: tracked, or untracked and not ignored."""
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, check=True).stdout
    return sorted({f for f in out.decode().split("\0") if f and (ROOT / f).is_file()})


def read_text(rel: str) -> str | None:
    p = ROOT / rel
    if p.suffix.lower() in BINARY_EXT or not p.is_file():
        return None
    data = p.read_bytes()
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace")


def strip_code(md: str) -> str:
    """Markdown with fenced blocks and inline code spans blanked, where 0x… is notation (docs/SPEC.md §3), not a
    placeholder. Line numbers are kept."""
    md = re.sub(r"^(```|~~~).*?^\1[^\n]*$", lambda m: "\n" * m.group(0).count("\n"), md, flags=re.S | re.M)
    return re.sub(r"`[^`\n]*`", lambda m: " " * len(m.group(0)), md)


def sdk_constants() -> dict[str, str]:
    src = (ROOT / "packages/letterlock/src/deployments.ts").read_text()
    rp = re.search(r'LETTERLOCK_RP_ID\s*=\s*"([^"]+)"', src)
    blocks = {name: re.search(rf'{name}\s*:\s*\{{[^}}]*?directory:\s*"(0x[0-9a-fA-F]{{40}})"', src, re.S) for name in ("monad", '"monad-testnet"')}
    return {
        "rpId": rp.group(1) if rp else "",
        "143": blocks["monad"].group(1) if blocks["monad"] else "",
        "10143": blocks['"monad-testnet"'].group(1) if blocks['"monad-testnet"'] else "",
    }


# ---------------------------------------------------------------------------------------------------------- license
def check_license() -> None:
    lic = next((ROOT / n for n in ("LICENSE", "LICENSE.md", "LICENSE.txt") if (ROOT / n).is_file()), None)
    if lic is None:
        record("license", "FAIL", "LICENSE at the repository root", "missing (packages/letterlock/LICENSE covers the SDK package only)")
    else:
        first = next((l.strip() for l in lic.read_text().splitlines() if l.strip()), "")
        record("license", "PASS", "LICENSE at the repository root", f"{lic.name}: {first}")


# ---------------------------------------------------------------------------------------------------------- deployments
def check_deployments(consts: dict[str, str]) -> dict[str, dict]:
    records: dict[str, dict] = {}
    for chain_id, network in (("143", "Monad mainnet"), ("10143", "Monad testnet")):
        path = ROOT / f"deployments/{chain_id}.json"
        if not path.is_file():
            record("deployments", "FAIL", f"deployments/{chain_id}.json ({network})", "missing")
            continue
        try:
            d = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            record("deployments", "FAIL", f"deployments/{chain_id}.json ({network})", f"not JSON: {e}")
            continue
        records[chain_id] = d
        problems = []
        if str(d.get("chainId")) != chain_id:
            problems.append(f"chainId is {d.get('chainId')}")
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", str(d.get("address", ""))):
            problems.append("no directory address")
        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(d.get("deployTx", ""))):
            problems.append("no deploy transaction")
        if d.get("verified") is not True:
            problems.append("not marked verified")
        if consts.get(chain_id) and str(d.get("address", "")).lower() != consts[chain_id].lower():
            problems.append(f"the SDK's DEPLOYMENTS names {consts[chain_id]}")
        if problems:
            record("deployments", "FAIL", f"deployments/{chain_id}.json ({network})", "; ".join(problems))
        else:
            v = d.get("verification", {}).get("match", "verified")
            record("deployments", "PASS", f"deployments/{chain_id}.json ({network})", f"{d['address']}, block {d.get('block')}, {v}; matches the SDK")
    return records


def rpc_call(url: str, method: str, params: list) -> object:
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "letterlock-readiness"})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read())
    if "error" in body:
        raise RuntimeError(body["error"])
    return body["result"]


def check_deployments_online(records: dict[str, dict]) -> None:
    rpcs = {"143": "https://rpc.monad.xyz", "10143": "https://testnet-rpc.monad.xyz"}
    for chain_id, d in records.items():
        try:
            code = rpc_call(rpcs[chain_id], "eth_getCode", [d["address"], "latest"])
            receipt = rpc_call(rpcs[chain_id], "eth_getTransactionReceipt", [d["deployTx"]])
            ok = isinstance(code, str) and len(code) > 2 and isinstance(receipt, dict) and receipt.get("status") == "0x1"
            record("deployments", "PASS" if ok else "FAIL", f"chain {chain_id}: code at {d['address']} (online)",
                   f"{(len(code) - 2) // 2} bytes of code, deploy receipt status {receipt.get('status') if isinstance(receipt, dict) else None}")
        except Exception as e:  # noqa: BLE001 - any RPC failure is reported, not raised
            record("deployments", "FAIL", f"chain {chain_id}: code at {d.get('address')} (online)", f"RPC failed: {e}")


# ---------------------------------------------------------------------------------------------------------- bench
def check_bench() -> dict | None:
    path = ROOT / "bench/results.json"
    if not path.is_file():
        record("bench", "FAIL", "bench/results.json", "missing: run pnpm bench")
        return None
    res = json.loads(path.read_text())
    generated = dt.datetime.fromisoformat(res["generatedAt"].replace("Z", "+00:00"))
    last = git("log", "-1", "--format=%H%x09%cI", "--", *SDK_RUNTIME_PATHS)
    measured = ((res.get("context") or {}).get("sdk") or {}).get("git") or {}
    n = (res.get("context") or {}).get("n")
    lat = res.get("latencyMs", {}).get("resolveAndSeal", {})
    if not last:
        record("bench", "WARN", "bench/results.json is newer than the SDK", "no git history to compare with")
    else:
        sha, date = last.split("\t")
        sdk_date = dt.datetime.fromisoformat(date)
        stale = generated < sdk_date or (measured.get("sdkCommit") and measured["sdkCommit"] != sha)
        detail = (f"measured {res['generatedAt']} on SDK {str(measured.get('sdkCommit', '?'))[:7]}; "
                  f"last SDK runtime commit {sha[:7]} at {date}")
        record("bench", "FAIL" if stale else "PASS", "bench/results.json is newer than the last SDK runtime commit",
               detail + ("; run pnpm bench again" if stale else ""))
        if measured.get("sdkDirty"):
            record("bench", "WARN", "bench measured committed SDK code", "the SDK had uncommitted changes when it was measured")
    if (git("status", "--porcelain", "--", *SDK_RUNTIME_PATHS)):
        record("bench", "WARN", "SDK runtime code is committed", "uncommitted changes under " + ", ".join(SDK_RUNTIME_PATHS) + ": the numbers belong to no commit yet")
    checks = res.get("checks", {})
    bad = len(checks.get("mismatches", [])) + len(checks.get("failures", []))
    record("bench", "PASS" if bad == 0 else "WARN", "bench run was clean",
           f"N={n}, resolve + seal p50 {lat.get('p50')} ms / p95 {lat.get('p95')} ms / p99 {lat.get('p99')} ms, "
           f"{len(checks.get('failures', []))} failed calls, {len(checks.get('mismatches', []))} mismatches")
    md = ROOT / "bench/RESULTS.md"
    if not md.is_file():
        record("bench", "FAIL", "bench/RESULTS.md", "missing: pnpm bench writes it with results.json")
    else:
        same = f"p50 {lat.get('p50')} ms" in md.read_text()
        record("bench", "PASS" if same else "FAIL", "bench/RESULTS.md was written from results.json",
               "its headline carries the same p50" if same else "its numbers differ from results.json: run pnpm bench again")
    return res


# ---------------------------------------------------------------------------------------------------------- docs
MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
BARE_URL = re.compile(r"https?://[^\s)<>\]\"'`]+")
VIDEO = re.compile(r"https?://(?:www\.)?(?:youtube\.com/(?:watch\?v=|shorts/|embed/)[A-Za-z0-9_-]{11}|youtu\.be/[A-Za-z0-9_-]{11}|(?:www\.)?loom\.com/share/[0-9a-f]{32}|vimeo\.com/\d{6,})")
TX = re.compile(r"https?://(?:www\.)?(?:" + "|".join(re.escape(e) for e in EXPLORERS) + r")/tx/0x[0-9a-fA-F]{64}")


def links_in(md: str) -> tuple[list[str], list[str]]:
    targets = MD_LINK.findall(md)
    urls = sorted(set(BARE_URL.findall(md)) | {t for t in targets if t.startswith("http")})
    return targets, urls


def is_relative(target: str) -> bool:
    return not (re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("#"))


def check_doc(name: str, requirements: list) -> str | None:
    """requirements: (what, predicate over the file's text) pairs."""
    path = ROOT / name
    if not path.is_file():
        record("docs", "FAIL", name, "missing")
        return None
    text = path.read_text()
    missing = [what for what, ok in requirements if not ok(text)]
    relative = [t.split("#")[0].split("?")[0] for t in links_in(text)[0] if is_relative(t)]
    broken = sorted({rel for rel in relative if rel and not (path.parent / rel).exists()})
    record("docs", "FAIL" if missing else "PASS", f"{name}: required links and commands",
           ("missing: " + "; ".join(missing)) if missing else f"all {len(requirements)} present")
    record("docs", "FAIL" if broken else "PASS", f"{name}: relative links resolve",
           ("broken: " + ", ".join(broken)) if broken else f"{len(relative)} relative links")
    return text


def check_docs(consts: dict[str, str], deployments: dict[str, dict], bench: dict | None, online: bool) -> None:
    app = f"https://{consts['rpId']}" if consts.get("rpId") else None
    directory = (deployments.get("143") or {}).get("address", "")
    lower = lambda s: s.lower()  # noqa: E731
    has_link_to = lambda target: (lambda t: any(x.split("#")[0].removeprefix("./") == target for x in links_in(t)[0]))  # noqa: E731
    readme_reqs = [
        (f"the live app ({app})", lambda t: bool(app) and app in t),
        ("a demo video link (YouTube, Loom or Vimeo, with a real id)", lambda t: bool(VIDEO.search(t))),
        (f"the mainnet directory {directory} on an explorer", lambda t: any(f"{e}/address/{directory.lower()}" in lower(t) for e in EXPLORERS)),
        ("a link to DEMO.md", has_link_to("DEMO.md")),
        ("a link to docs/SPEC.md", has_link_to("docs/SPEC.md")),
        ("a link to bench/RESULTS.md", has_link_to("bench/RESULTS.md")),
        ("a link to LICENSE", has_link_to("LICENSE")),
    ]
    demo_reqs = [
        (f"the live app ({app})", lambda t: bool(app) and app in t),
        ("the command pnpm verify", lambda t: "pnpm verify" in t),
        ("the command pnpm bench", lambda t: "pnpm bench" in t),
        ("a mainnet transaction on an explorer", lambda t: bool(TX.search(t))),
        (f"the mainnet directory {directory}", lambda t: directory.lower() in lower(t)),
    ]
    texts = {n: check_doc(n, r) for n, r in (("README.md", readme_reqs), ("DEMO.md", demo_reqs))}
    videos = set(VIDEO.findall(texts.get("README.md") or ""))
    if texts.get("README.md") is not None and len(videos) < 2:
        record("docs", "WARN", "README.md: demo video and pitch video", f"{len(videos)} video link(s); the event asks for a demo video (3 min) and a pitch video (2 min)")

    # every latency figure the docs quote must be one bench/results.json holds
    if bench is not None:
        lat = bench.get("latencyMs", {})
        held = [float(v) for s in lat.values() if isinstance(s, dict) for k, v in s.items() if k != "n"] + [float(lat.get("coldFirstResolve", -1))]
        # a quoted figure may be rounded: 29.4 matches a held 29.435, never a held 29.5
        decimals = lambda q: len(q.split(".")[1]) if "." in q else 0  # noqa: E731
        holds = lambda q: any(round(h, decimals(q)) == float(q) for h in held)  # noqa: E731
        for name, text in texts.items():
            if text is None:
                continue
            quoted = re.findall(r"\bp(?:50|95|99)\b[^0-9\n]{0,24}?(\d+(?:\.\d+)?)\s*ms", text)
            wrong = sorted({q for q in quoted if not holds(q)})
            if quoted:
                record("docs", "FAIL" if wrong else "PASS", f"{name}: latency figures match bench/results.json",
                       ("not in bench/results.json: " + ", ".join(f"{w} ms" for w in wrong)) if wrong else f"{len(quoted)} figure(s), all from the last run")

    if online:
        urls = sorted({u.rstrip(".,;") for t in texts.values() if t for u in links_in(t)[1]} | ({app} if app else set()))
        dead = []
        for u in urls:
            status = http_status(u)
            if status is None or status >= 400:
                dead.append(f"{u} ({status or 'no answer'})")
        record("docs", "FAIL" if dead else "PASS", "external links answer (online)", ("dead: " + "; ".join(dead)) if dead else f"{len(urls)} links, all below HTTP 400")


def http_status(url: str) -> int | None:
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method, headers={"user-agent": "Mozilla/5.0 letterlock-readiness"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 405, 501):
                continue
            return e.code
        except Exception:  # noqa: BLE001
            if method == "GET":
                return None
    return None


# ---------------------------------------------------------------------------------------------------------- placeholders
PLACEHOLDERS = [
    ("TODO", re.compile(r"\bTODO\b")),
    ("TBD", re.compile(r"\bTBD\b")),
    ("FIXME", re.compile(r"\bFIXME\b")),
    ("XXX", re.compile(r"\b[Xx]{3,}\b")),
    ("lorem ipsum", re.compile(r"\blorem\b", re.I)),
    ("placeholder video link", re.compile(r"(?:youtu\.be/|youtube\.com/watch\?v=|youtube\.com/shorts/)(?![A-Za-z0-9_-]{11}(?![A-Za-z0-9_-]))")),
]
BARE_0X = re.compile(r"(?<![0-9A-Za-z])0x(?:…|\.\.\.)(?![0-9A-Fa-f])")


def check_placeholders(files: list[str]) -> None:
    hits: list[str] = []
    scanned = 0
    for f in files:
        if f in SKIP_FILES or f.startswith(SKIP_DIRS) or "/qa/" in f or (ROOT / f).resolve() == SELF:
            continue
        text = read_text(f)
        if text is None:
            continue
        scanned += 1
        prose = strip_code(text) if f.endswith(".md") else None
        for i, line in enumerate(text.splitlines(), 1):
            for label, rx in PLACEHOLDERS:
                if rx.search(line):
                    hits.append(f"{f}:{i} {label}")
        if prose is not None:
            for i, line in enumerate(prose.splitlines(), 1):
                if BARE_0X.search(line):
                    hits.append(f"{f}:{i} bare 0x…")
    record("placeholders", "FAIL" if hits else "PASS", "no placeholder in a file the repository publishes",
           (f"{len(hits)} found: " + "; ".join(hits[:12]) + (" ..." if len(hits) > 12 else "")) if hits else f"{scanned} text files scanned")


# ---------------------------------------------------------------------------------------------------------- fixtures
def check_fixtures() -> None:
    env = ROOT / "fixtures/envelopes.json"
    if not env.is_file():
        record("fixtures", "FAIL", "fixtures/envelopes.json", "missing: pnpm fixtures --write")
    else:
        d = json.loads(env.read_text())
        record("fixtures", "PASS", "fixtures/envelopes.json", f"{len(d.get('offline', []))} offline cases replayed by pnpm verify, seed plan of {len(d.get('seed', {}).get('notes', []))} notes")
    seeded = ROOT / "fixtures/seeded/143.json"
    if not seeded.is_file():
        record("fixtures", "WARN", "a mainnet seed run is recorded (fixtures/seeded/143.json)",
               "none yet: persona inboxes are empty until pnpm seed --mainnet --confirm-mainnet --to <persona> runs")
    else:
        runs = json.loads(seeded.read_text()).get("runs", [])
        drops = sum(len(r.get("drops", [])) for r in runs)
        record("fixtures", "PASS", "a mainnet seed run is recorded (fixtures/seeded/143.json)", f"{len(runs)} run(s), {drops} drops")


# ---------------------------------------------------------------------------------------------------------- public repo
def check_public(files: list[str]) -> None:
    agent_files = [f for f in files if re.search(r"(^|/)(CLAUDE|AGENTS)\.md$", f) or re.search(r"(^|/)\.claude/", f)]
    record("public repo", "FAIL" if agent_files else "PASS", "no CLAUDE.md, AGENTS.md or .claude/", ", ".join(agent_files) or "none")
    env_files = [f for f in files if re.search(r"(^|/)\.env($|\.)", f) and not f.endswith(".example")]
    record("public repo", "FAIL" if env_files else "PASS", "no .env file", ", ".join(env_files) or "none")
    key_rx = re.compile(r"(PRIVATE_KEY|SECRET_KEY|MNEMONIC)\s*[:=]\s*[\"']?(0x)?[0-9a-fA-F]{64}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----")
    keys = []
    for f in files:
        if (ROOT / f).resolve() == SELF:
            continue
        text = read_text(f)
        if text and key_rx.search(text):
            keys.append(f)
    record("public repo", "FAIL" if keys else "PASS", "no private key or PEM block in a published file", ", ".join(keys) or "none")
    planning = ROOT.parent / "specs"
    names = sorted(p.name for p in planning.glob("*.md") if p.name != "README.md") if planning.is_dir() else []
    if not names:
        record("public repo", "PASS", "no private planning-note name", "no planning folder next to the repository: nothing to compare")
        return
    pats = []
    for n in names:
        stem = n[:-3]
        for s in [n] + ([stem] if "-" in stem else []):
            pats.append(re.compile(r"(^|[^A-Za-z0-9_-])" + re.escape(s) + r"(?![A-Za-z0-9_-])"))
    hits = []
    for f in files:
        text = read_text(f)
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if any(p.search(line) for p in pats):
                hits.append(f"{f}:{i}")
    record("public repo", "FAIL" if hits else "PASS", "no private planning-note name in a published file",
           ", ".join(hits[:10]) if hits else f"{len(names)} names checked")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--online", action="store_true", help="also fetch the live app, the docs' external links and both directories' code")
    args = ap.parse_args()

    files = publishable_files()
    consts = sdk_constants()
    check_license()
    deployments = check_deployments(consts)
    if args.online:
        check_deployments_online(deployments)
    bench = check_bench()
    check_docs(consts, deployments, bench, args.online)
    check_placeholders(files)
    check_fixtures()
    check_public(files)

    head = git("rev-parse", "--short", "HEAD") or "?"
    dirty = " with uncommitted changes" if git("status", "--porcelain") else ""
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"Letterlock submission readiness · {now} · {head}{dirty}{' · online' if args.online else ''}\n")
    order = ["docs", "placeholders", "deployments", "bench", "fixtures", "license", "public repo"]
    for section in order:
        rows = [r for r in results if r[0] == section]
        if not rows:
            continue
        print(section)
        for _, status, title, detail in rows:
            print(f"  [{status}] {title}" + (f"\n         {detail}" if detail else ""))
    fails = sum(1 for r in results if r[1] == "FAIL")
    warns = sum(1 for r in results if r[1] == "WARN")
    passes = sum(1 for r in results if r[1] == "PASS")
    print(f"\n{passes} passed, {fails} failed, {warns} warnings: {'READY' if fails == 0 else 'NOT READY'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
