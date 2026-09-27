#!/usr/bin/env python3
"""Submission readiness: a checklist of what a judge opens first, and exit code 1 while anything fails.

  pnpm readiness              python3 scripts/check_submission_readiness.py
  pnpm readiness --online     also fetch the live app, every external link in README.md and DEMO.md, each video's
                              oEmbed record, and the code of both directories over JSON-RPC

Checks (FAIL blocks a submission, WARN is worth a look):
  docs         README.md and DEMO.md exist and carry the links a judge needs: the live app (the SDK's rpId host), a
               video, the mainnet directory on an explorer, mainnet transactions, the reproduce commands, and links to
               DEMO.md, docs/SPEC.md, bench/RESULTS.md and LICENSE; every relative link resolves; every video exists
               (--online asks YouTube, Vimeo or Loom for its oEmbed record; a watch URL answers 200 even for a video
               that does not exist, so offline the video is a WARN, never a PASS); and every latency figure is the one
               bench/results.json holds for the operation and the statistic it names (latency_problems below)
  placeholders no TODO, TBD, FIXME, XXX / 0xXXXX…, lorem ipsum, "coming soon", example.com, youtu.be/xxx-style or
               placeholder video ids, a bare 0x... / 0x… or an <UPPER_CASE> slot in prose, or a todo / fixme / tbd
               marker in a comment, in any file the repository will publish (tracked, or untracked and not ignored)
  deployments  deployments/143.json and 10143.json exist, name a verified directory, and match the SDK's DEPLOYMENTS
  bench        bench/results.json exists, is newer than the last commit that changed the SDK's runtime code
               (packages/letterlock/src, packages/letterlock/package.json: the paths scripts/lib/git.ts names), was
               measured on that commit, had no failed call and no mismatch, and bench/RESULTS.md was written from it
  fixtures     fixtures/envelopes.json exists; a complete mainnet seed run is recorded: status "sent and read back", to
               the directory deployments/143.json names, with at least 5 drops (WARN until one is)
  license      LICENSE at the root
  public repo  no CLAUDE.md, AGENTS.md or .claude/, no .env file, no private key or PEM block, and no name of a
               private planning note (read from the folder next to the repository, never spelled out here), in the
               published files AND in the git history, which goes public with them
Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve()
SDK_RUNTIME_PATHS = ["packages/letterlock/src", "packages/letterlock/package.json"]
EXPLORERS = ("monadvision.com", "monadscan.com")
SKIP_DIRS = ("contracts/lib/", "node_modules/")
SKIP_FILES = {"pnpm-lock.yaml", "bench/results.json"}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".mp4", ".mov", ".webm", ".zip", ".svg"}
MIN_SEED_DROPS = 5  # the 4 notes and the tampered copy; the old-epoch note is a sixth when a persona has rotated

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
    ctx = res.get("context") or {}
    measured = (ctx.get("sdk") or {}).get("git") or {}
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
        if measured.get("benchDirty"):
            record("bench", "WARN", "bench ran committed bench code", "scripts/bench.ts or scripts/lib had uncommitted changes when it ran")
    if (git("status", "--porcelain", "--", *SDK_RUNTIME_PATHS)):
        record("bench", "WARN", "SDK runtime code is committed", "uncommitted changes under " + ", ".join(SDK_RUNTIME_PATHS) + ": the numbers belong to no commit yet")
    checks = res.get("checks", {})
    failures, mismatches = len(checks.get("failures", [])), len(checks.get("mismatches", []))
    runs = ctx.get("runs", 1)
    record("bench", "PASS" if failures + mismatches == 0 else "FAIL", "bench run was clean",
           f"N={lat.get('n')} ({runs} run(s) of {ctx.get('n')} rounds), resolve + seal p50 {lat.get('p50')} ms / p95 {lat.get('p95')} ms / "
           f"p99 {lat.get('p99')} ms, {failures} failed calls, {mismatches} mismatches" + ("; run pnpm bench again" if failures + mismatches else ""))
    md = ROOT / "bench/RESULTS.md"
    if not md.is_file():
        record("bench", "FAIL", "bench/RESULTS.md", "missing: pnpm bench writes it with results.json")
    else:
        text = md.read_text()
        absent = [f"{k} {lat.get(k)} ms" for k in ("p50", "p95", "p99") if f"{k} {lat.get(k)} ms" not in text]
        record("bench", "FAIL" if absent else "PASS", "bench/RESULTS.md was written from results.json",
               f"its headline lacks {', '.join(absent)}: run pnpm bench again" if absent else "its headline carries the same p50, p95 and p99")
    return res


# ---------------------------------------------------------------------------------------------------------- latency figures
# Every "<number> ms" in README.md and DEMO.md is a claim about bench/results.json unless its paragraph (or table row)
# carries EXEMPT. A claim names an operation (resolve + seal, resolve, seal, rpc round trip, cold first resolve: the
# nearest one before the figure in its paragraph, else the nearest after; in a table, the row's first cell) and a
# statistic (p50 or median, p95, p99, min, max, mean: right before the figure, "p50 23.1 ms", "p50/p95/p99: a/b/c ms",
# or right after it, "23.1 ms (p50)", "23.1 ms at the median"; in a table, the column's header). A single figure must
# equal that statistic of that operation over all runs, rounded to the figure's own decimals: 23.1 and 23 both match
# 23.117, 17.7 never does, and a p50 never matches a min, a max or a mean. A range, "the p50 ranged 23.1–29.4 ms", must
# equal the lowest and the highest value of that statistic among the runs. In prose a figure that cannot be tied to an
# operation and a statistic fails; in a code block only a figure with a statistic is a claim (commands carry timeouts).
EXEMPT = "<!-- readiness: not a bench figure -->"
NUM = r"\d+(?:\.\d+)?"
FIGURE = re.compile(rf"(?<![\w.])(?P<nums>{NUM}(?:\s*(?:/|–|—|-|\bto\b|\band\b)\s*{NUM})*)\s*(?:ms|milliseconds?)\b", re.I)
SEPARATOR = re.compile(r"\s*(?:/|–|—|-|\bto\b|\band\b)\s*", re.I)
STAT_OF = {"p50": "p50", "median": "p50", "p95": "p95", "p99": "p99", "min": "min", "minimum": "min", "max": "max", "maximum": "max",
           "mean": "mean", "average": "mean", "avg": "mean"}
LABEL = r"(?:p50|p95|p99|median|minimum|min|maximum|max|mean|average|avg)"
LABELS = re.compile(rf"(?<![\w-]){LABEL}(?:\s*/\s*{LABEL})*(?![\w-])", re.I)
BEFORE = re.compile(r"[\s*_:=~≈(]*(?:(?:of|is|was|were|at|in|about|around|roughly|approximately|ranged|ranges|range|from|between|varied|"
                    r"moved|took|takes|stays|under|below)\b[\s*_:=~≈(]*)*", re.I)
AFTER = re.compile(r"[\s*_(]*(?:(?:at|the|for|as|in)\b[\s*_(]*)*", re.I)
OPS = [
    ("resolveAndSeal", r"resolve\s*(?:\+|&|and)\s*seal|resolve-and-seal|resolveAndSeal|sealTo"),
    ("coldFirstResolve", r"cold(?:\s+first)?\s+resolve|first\s+resolve|coldFirstResolve"),
    ("rpcRoundTrip", r"(?:rpc\s+)?round[\s-]?trip|eth_blockNumber|rpcRoundTrip"),
    ("resolve", r"resolv(?:e|es|ed|ing)"),
    ("seal", r"seal(?:s|ed|ing)?"),
]
OP_MENTION = re.compile("|".join(rf"(?P<{key}>(?<![\w-])(?:{rx})(?![\w-]))" for key, rx in OPS), re.I)
OP_NAME = {"resolveAndSeal": "resolve + seal", "coldFirstResolve": "cold first resolve", "rpcRoundTrip": "rpc round trip", "resolve": "resolve", "seal": "seal"}


def matches(quoted: str, held: float) -> bool:
    """A quoted figure matches a held value rounded (half up) to the figure's own decimals: 29.4 matches 29.435."""
    q = Decimal(quoted)
    return Decimal(repr(float(held))).quantize(Decimal(1).scaleb(q.as_tuple().exponent), rounding=ROUND_HALF_UP) == q


def figure_units(md: str) -> list[tuple[int, str, bool]]:
    """(first line, text, in a code block) for each paragraph, list item, heading, table row and code line. A table row
    reads as "<first cell> ; <header stat> <cell> ms ; …", its other cells as units of their own."""
    lines = md.split("\n")
    units: list[tuple[int, str, bool]] = []
    buf: list[str] = []
    start = 0
    fence = None

    def flush() -> None:
        nonlocal buf
        if buf:
            units.append((start, "\n".join(buf), False))
        buf = []

    def cells(row: str) -> list[str]:
        return [c.strip() for c in row.strip().strip("|").split("|")]

    i = 0
    while i < len(lines):
        line = lines[i]
        opening = re.match(r"^\s*(```|~~~)", line)
        if fence:
            if opening and opening.group(1) == fence:
                fence = None
            else:
                units.append((i + 1, line, True))
            i += 1
            continue
        if opening:
            flush()
            fence = opening.group(1)
            i += 1
            continue
        if line.lstrip().startswith("|"):
            flush()
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            rows = lines[i:j]
            if len(rows) >= 2 and re.match(r"^\s*\|?\s*:?-{3,}", rows[1]):
                header = cells(rows[0])
                for k, row in enumerate(rows[2:], start=i + 3):
                    cs = cells(row)
                    figs, others = [], []
                    for c_i, c in enumerate(cs):
                        head = header[c_i] if c_i < len(header) else ""
                        bare = re.fullmatch(rf"[*_~\s]*(?P<n>{NUM})\s*(?P<ms>ms)?[*_\s]*", c, re.I)
                        stats = [m.group(0) for m in LABELS.finditer(head)]
                        if bare and (bare.group("ms") or stats or re.search(r"\bms\b|millisecond", head, re.I)):
                            figs.append(f"{stats[0] if len(stats) == 1 else ''} {bare.group('n')} ms".strip())
                        elif c_i > 0:
                            others.append(c)
                    first = cs[0] if cs and not re.fullmatch(rf"[*_~\s]*{NUM}\s*(ms)?[*_\s]*", cs[0], re.I) else ""
                    exempt = EXEMPT if EXEMPT in row else ""
                    units.append((k, " ; ".join([first, *figs]) + exempt, False))
                    units.extend((k, o, False) for o in others)
            else:
                units.extend((i + 1 + k, row, False) for k, row in enumerate(rows))
            i = j
            continue
        if not line.strip():
            flush()
            i += 1
            continue
        if re.match(r"^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)", line):
            flush()
        if not buf:
            start = i + 1
        buf.append(line.replace("`", " "))
        i += 1
    flush()
    return units


def latency_problems(md: str, bench: dict) -> tuple[int, int, list[str]]:
    """(figures checked, figures exempt, problems as 'line: …') for one Markdown file against bench/results.json."""
    lat = bench.get("latencyMs", {})
    runs = bench.get("runs", [])
    checked, exempt, problems = 0, 0, []

    def held(op: str, stat: str | None) -> float | None:
        v = lat.get(op)
        if isinstance(v, (int, float)):  # schema 1: the cold first resolve was one sample
            return float(v)
        if isinstance(v, dict) and stat is not None and isinstance(v.get(stat), (int, float)):
            return float(v[stat])
        return None

    def run_range(op: str, stat: str) -> tuple[float, float] | None:
        vals = [r.get("latencyMs", {}).get(op, {}).get(stat) for r in runs]
        vals = [float(v) for v in vals if isinstance(v, (int, float))]
        return (min(vals), max(vals)) if len(vals) >= 2 else None

    for first_line, text, in_code in figure_units(md):
        figures = list(FIGURE.finditer(text))
        if not figures:
            continue
        if EXEMPT in text:
            exempt += len(figures)
            continue
        labels = list(LABELS.finditer(text))
        ops = [(m.start(), m.end(), m.lastgroup) for m in OP_MENTION.finditer(text)]
        for f in figures:
            where = f"{first_line + text[:f.start()].count(chr(10))}"
            shown = f.group(0).strip()
            label = None
            before = [l for l in labels if l.end() <= f.start()]
            if before:
                between = text[before[-1].end():f.start()]
                if len(between) <= 40 and not re.search(r"\d", between) and BEFORE.fullmatch(between):
                    label = before[-1]
            if label is None:
                after = [l for l in labels if l.start() >= f.end()]
                if after:
                    between = text[f.end():after[0].start()]
                    if len(between) <= 24 and not re.search(r"\d", between) and AFTER.fullmatch(between):
                        label = after[0]
            stats = [STAT_OF[s.strip().lower()] for s in label.group(0).split("/")] if label else []
            prior = [o for o in ops if o[1] <= f.start()]
            later = [o for o in ops if o[0] >= f.end()]
            op = prior[-1][2] if prior else later[0][2] if later else None
            if in_code and not stats:
                continue  # code: a figure without a statistic is a timeout or an interval, not a claim
            nums = SEPARATOR.split(f.group("nums"))
            is_list = "/" in f.group("nums")
            if op is None and not stats:
                problems.append(f"{where}: {shown} names no operation and no statistic (tie it to one, or mark the paragraph {EXEMPT})")
                continue
            if op is None:
                problems.append(f"{where}: {shown} names no operation (resolve + seal, resolve, seal, rpc round trip or cold first resolve)")
                continue
            scalar = isinstance(lat.get(op), (int, float))
            if not stats and not scalar:
                problems.append(f"{where}: {shown} for {OP_NAME[op]} names no statistic (p50, p95, p99, min, max or mean)")
                continue
            checked += len(nums)
            if is_list:
                if len(stats) != len(nums):
                    problems.append(f"{where}: {shown} pairs {len(nums)} figures with {len(stats) or 'no'} statistic(s)")
                    continue
                pairs = list(zip(stats, nums))
            elif len(nums) == 2:  # a range: the lowest and the highest run
                if len(stats) != 1:
                    problems.append(f"{where}: {shown} is a range with {len(stats) or 'no'} statistics; name one")
                    continue
                span = run_range(op, stats[0])
                if span is None:
                    problems.append(f"{where}: {shown} is a range of {OP_NAME[op]} {stats[0]}, and bench/results.json holds no runs to span")
                elif not (matches(nums[0], span[0]) and matches(nums[1], span[1])):
                    problems.append(f"{where}: {shown} for {OP_NAME[op]} {stats[0]} across runs: bench/results.json has {span[0]}–{span[1]} ms")
                continue
            elif len(nums) == 1:
                pairs = [(stats[0] if stats else None, nums[0])]
                if len(stats) > 1:
                    problems.append(f"{where}: {shown} is one figure under {len(stats)} statistics")
                    continue
            else:
                problems.append(f"{where}: {shown} cannot be read as one figure, a list or a range")
                continue
            for stat, q in pairs:
                h = held(op, stat)
                if h is None:
                    problems.append(f"{where}: {q} ms: bench/results.json has no {stat or 'value'} for {OP_NAME[op]}")
                elif not matches(q, h):
                    problems.append(f"{where}: {q} ms for {OP_NAME[op]} {stat or ''}: bench/results.json has {h} ms".replace("  ", " "))
    return checked, exempt, problems


# ---------------------------------------------------------------------------------------------------------- docs
MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
BARE_URL = re.compile(r"https?://[^\s)<>\]\"'`]+")
VIDEO = re.compile(r"https?://(?:www\.)?(?:youtube\.com/(?:watch\?v=|shorts/|embed/)[A-Za-z0-9_-]{11}|youtu\.be/[A-Za-z0-9_-]{11}|(?:www\.)?loom\.com/share/[0-9a-f]{32}|vimeo\.com/\d{6,})")
TX = re.compile(r"https?://(?:www\.)?(?:" + "|".join(re.escape(e) for e in EXPLORERS) + r")/tx/0x[0-9a-fA-F]{64}")
KNOWN_PLACEHOLDER_VIDEOS = {"dQw4w9WgXcQ"}  # the video every tutorial links as a stand-in


def video_id(url: str) -> str:
    return re.split(r"watch\?v=|shorts/|embed/|youtu\.be/|share/|vimeo\.com/", url)[-1]


def placeholder_video(url: str) -> bool:
    """An id no real upload has: one or two distinct characters (aaaaaaaaaaa, xxxxxxxxxxx), or a well-known stand-in."""
    vid = video_id(url)
    return len(set(vid.lower())) <= 2 or vid in KNOWN_PLACEHOLDER_VIDEOS


def oembed_url(url: str) -> str:
    """The provider's oEmbed endpoint for a video: it answers 200 only for a video that exists and is viewable."""
    if "loom.com" in url:
        return "https://www.loom.com/v1/oembed?url=" + urllib.parse.quote(url, safe="")
    if "vimeo.com" in url:
        return "https://vimeo.com/api/oembed.json?url=" + urllib.parse.quote(url, safe="")
    watch = f"https://www.youtube.com/watch?v={video_id(url)}"
    return "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(watch, safe="")


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


def check_videos(text: str, online: bool, status_of=None) -> None:
    """Each video link in README.md: not a placeholder id, and (online) a video its provider's oEmbed endpoint knows."""
    status_of = status_of or http_status
    videos = sorted(set(VIDEO.findall(text)))
    if not videos:
        return
    fake = [v for v in videos if placeholder_video(v)]
    if fake:
        record("docs", "FAIL", "README.md: video ids are real", "placeholder id: " + ", ".join(fake))
    if not online:
        record("docs", "WARN", "README.md: the videos exist", f"{len(videos)} video link(s) not verified: run pnpm readiness --online "
               "(a YouTube watch URL answers 200 even for a video that does not exist; its oEmbed endpoint does not)")
        return
    answers = {v: status_of(oembed_url(v)) for v in videos}
    dead = [f"{v} (oEmbed {s or 'no answer'})" for v, s in answers.items() if s != 200]
    record("docs", "FAIL" if dead else "PASS", "README.md: the videos exist (online, oEmbed)",
           ("not found: " + "; ".join(dead)) if dead else f"{len(videos)} video(s), each known to its provider")


def check_docs(consts: dict[str, str], deployments: dict[str, dict], bench: dict | None, online: bool) -> None:
    app = f"https://{consts['rpId']}" if consts.get("rpId") else None
    directory = (deployments.get("143") or {}).get("address", "")
    lower = lambda s: s.lower()  # noqa: E731
    has_link_to = lambda target: (lambda t: any(x.split("#")[0].removeprefix("./") == target for x in links_in(t)[0]))  # noqa: E731
    readme_reqs = [
        (f"the live app ({app})", lambda t: bool(app) and app in t),
        ("a demo video link (YouTube, Loom or Vimeo, with a well-formed id)", lambda t: bool(VIDEO.search(t))),
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
    readme = texts.get("README.md")
    if readme is not None:
        videos = set(VIDEO.findall(readme))
        if len(videos) < 2:
            record("docs", "WARN", "README.md: demo video and pitch video", f"{len(videos)} video link(s); the event asks for a demo video (3 min) and a pitch video (2 min)")
        check_videos(readme, online)

    # every latency figure the docs quote must be the one bench/results.json holds for its operation and statistic
    if bench is not None:
        for name, text in texts.items():
            if text is None:
                continue
            checked, exempt, problems = latency_problems(text, bench)
            note = f"; {exempt} marked not a bench figure" if exempt else ""
            record("docs", "FAIL" if problems else "PASS", f"{name}: latency figures match bench/results.json",
                   ("; ".join(problems[:8]) + (f" ... {len(problems) - 8} more" if len(problems) > 8 else "")) if problems
                   else (f"{checked} figure(s), each tied to an operation and a statistic{note}" if checked else f"no latency figure quoted{note}"))

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
    ("XXX", re.compile(r"(?<![A-Za-z0-9])(?:0x)?[Xx]{3,}(?![A-Za-z0-9])")),  # XXX, xxxx, 0xXXXX…
    ("lorem ipsum", re.compile(r"\blorem\b", re.I)),
    ("coming soon", re.compile(r"\bcoming soon\b", re.I)),
    ("placeholder video link", re.compile(r"(?:youtu\.be/|youtube\.com/watch\?v=|youtube\.com/shorts/)(?![A-Za-z0-9_-]{11}(?![A-Za-z0-9_-]))")),
]
EXAMPLE_DOMAIN = re.compile(r"\bexample\.(?:com|org|net)\b", re.I)
BARE_0X = re.compile(r"(?<![0-9A-Za-z])0x(?:…|\.\.\.)(?![0-9A-Fa-f])")
SLOT = re.compile(r"<[A-Z][A-Z0-9_]{2,}>")  # <YOUR_EMAIL>, <ADDRESS>: an unfilled slot in prose
HASH_COMMENTS = {".py", ".sh", ".yml", ".yaml", ".toml"}
COMMENT_MARKER = re.compile(r"^(?:todo|fixme|tbd|xxx)\b|\b(?:todo|fixme|tbd)\s*[:(!]", re.I)


def comment_text(path: str, line: str) -> str | None:
    """The comment part of a line of code, roughly: after //, /*, a leading *, <!--, or # in a hash-comment language."""
    suffix = Path(path).suffix.lower()
    if suffix == ".md":
        m = re.search(r"<!--(.*)", line)
        return m.group(1) if m else None
    m = re.search(r"(?:^|\s)(?://|/\*)(.*)$", line) or re.match(r"^\s*\*\s?(.*)$", line) or re.search(r"<!--(.*)", line)
    if m is None and suffix in HASH_COMMENTS:
        m = re.search(r"(?:^|\s)#(.*)$", line)
    return m.group(1) if m else None


def is_test_file(path: str) -> bool:
    return bool(re.search(r"(^|/)(test|tests|e2e)/|\.test\.|\.spec\.|(^|/)test_[^/]*\.py$", path))


def placeholder_hits(path: str, text: str) -> list[str]:
    """Every placeholder in one published file, as 'path:line label'."""
    hits: list[str] = []
    prose = strip_code(text) if path.endswith(".md") else None
    for i, line in enumerate(text.splitlines(), 1):
        for label, rx in PLACEHOLDERS:
            if rx.search(line):
                hits.append(f"{path}:{i} {label}")
        if not is_test_file(path) and EXAMPLE_DOMAIN.search(line):
            hits.append(f"{path}:{i} example domain")
        comment = comment_text(path, line)
        if comment is not None and COMMENT_MARKER.search(comment.strip()) and not any(h.startswith(f"{path}:{i} ") for h in hits):
            hits.append(f"{path}:{i} {COMMENT_MARKER.search(comment.strip()).group(0).strip(' :(!').lower()} marker")
    for v in VIDEO.findall(text):
        if placeholder_video(v):
            hits.append(f"{path} placeholder video id {video_id(v)}")
    if prose is not None:
        for i, line in enumerate(prose.splitlines(), 1):
            if BARE_0X.search(line):
                hits.append(f"{path}:{i} bare 0x…")
            if SLOT.search(line):
                hits.append(f"{path}:{i} unfilled {SLOT.search(line).group(0)}")
    return hits


def skipped_from_scan(f: str) -> bool:
    """Generated or vendored files: the lockfile, the bench's raw samples, the fixtures' JSON (random base64), submodules."""
    return f in SKIP_FILES or f.startswith(SKIP_DIRS) or (f.startswith("fixtures/") and f.endswith(".json")) or (ROOT / f).resolve() == SELF


def check_placeholders(files: list[str]) -> None:
    hits: list[str] = []
    scanned = 0
    for f in files:
        if skipped_from_scan(f):
            continue
        text = read_text(f)
        if text is None:
            continue
        scanned += 1
        hits.extend(placeholder_hits(f, text))
    record("placeholders", "FAIL" if hits else "PASS", "no placeholder in a file the repository publishes",
           (f"{len(hits)} found: " + "; ".join(hits[:12]) + (" ..." if len(hits) > 12 else "")) if hits else f"{scanned} text files scanned")


# ---------------------------------------------------------------------------------------------------------- fixtures
def seed_run_problems(run: dict, directory: str) -> list[str]:
    """Why a recorded seed run does not count as a complete mainnet seed: [] when it does."""
    problems = []
    status = str(run.get("status", ""))
    if not status.startswith("sent and read back"):
        problems.append(f"status {status[:80]!r}")
    if run.get("chainId") != 143:
        problems.append(f"chain {run.get('chainId')}")
    if not directory or str(run.get("directory", "")).lower() != directory.lower():
        problems.append(f"directory {run.get('directory')} is not the one deployments/143.json records ({directory or 'none'})")
    drops = len(run.get("drops", []))
    if drops < MIN_SEED_DROPS:
        problems.append(f"{drops} drops, fewer than {MIN_SEED_DROPS}")
    return problems


def check_fixtures(deployments: dict[str, dict] | None = None) -> None:
    env = ROOT / "fixtures/envelopes.json"
    if not env.is_file():
        record("fixtures", "FAIL", "fixtures/envelopes.json", "missing: pnpm fixtures --write")
    else:
        d = json.loads(env.read_text())
        record("fixtures", "PASS", "fixtures/envelopes.json", f"{len(d.get('offline', []))} offline cases replayed by pnpm verify, seed plan of {len(d.get('seed', {}).get('notes', []))} notes")
    title = "a complete mainnet seed run is recorded (fixtures/seeded/143.json)"
    seeded = ROOT / "fixtures/seeded/143.json"
    if not seeded.is_file():
        record("fixtures", "WARN", title, "none yet: persona inboxes are empty until pnpm seed --mainnet --confirm-mainnet --to <persona> runs")
        return
    directory = str(((deployments or {}).get("143") or {}).get("address", ""))
    runs = json.loads(seeded.read_text()).get("runs", [])
    complete = [r for r in runs if not seed_run_problems(r, directory)]
    if complete:
        record("fixtures", "PASS", title, f"{len(complete)} complete run(s) of {len(runs)} to {directory}, {sum(len(r['drops']) for r in complete)} drops read back")
    else:
        why = "; ".join(f"run at {r.get('at', '?')}: " + ", ".join(seed_run_problems(r, directory)) for r in runs[-3:])
        record("fixtures", "WARN", title, f"{len(runs)} run(s), none complete: {why}" if runs else "the file records no run")


# ---------------------------------------------------------------------------------------------------------- public repo
KEY_RX = re.compile(r"(PRIVATE_KEY|SECRET_KEY|MNEMONIC)\s*[:=]\s*[\"']?(0x)?[0-9a-fA-F]{64}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----")


def planning_patterns() -> tuple[list[str], list[re.Pattern]]:
    """The private planning notes' names, from the folder next to the repository, and the patterns that find them."""
    planning = ROOT.parent / "specs"
    names = sorted(p.name for p in planning.glob("*.md") if p.name != "README.md") if planning.is_dir() else []
    pats = []
    for n in names:
        stem = n[:-3]
        for s in [n] + ([stem] if "-" in stem else []):
            pats.append(re.compile(r"(^|[^A-Za-z0-9_-])" + re.escape(s) + r"(?![A-Za-z0-9_-])"))
    return names, pats


def history_hits(pats: list[re.Pattern]) -> tuple[dict[str, set[int]], list[str], int]:
    """Scans every commit's patch (git log --all -p): the commits whose added or removed lines name a planning note
    ({commit: the patterns found}), the commits that add or remove a private key, and the number of commits read."""
    out = subprocess.run(["git", "log", "--all", "-p", "--format=commit %h", "--abbrev=7", "--no-color", "--no-ext-diff"],
                         cwd=ROOT, capture_output=True, check=False).stdout.decode("utf-8", errors="replace")
    names: dict[str, set[int]] = {}
    keys: list[str] = []
    commit = ""
    commits = 0
    for line in out.split("\n"):
        if line.startswith("commit "):
            commit = line[7:].strip()
            commits += 1
            continue
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        body = line[1:]
        for k, p in enumerate(pats):
            if p.search(body):
                names.setdefault(commit, set()).add(k)
        if KEY_RX.search(body) and commit not in keys:
            keys.append(commit)
    return names, keys, commits


def check_public(files: list[str]) -> None:
    agent_files = [f for f in files if re.search(r"(^|/)(CLAUDE|AGENTS)\.md$", f) or re.search(r"(^|/)\.claude/", f)]
    record("public repo", "FAIL" if agent_files else "PASS", "no CLAUDE.md, AGENTS.md or .claude/", ", ".join(agent_files) or "none")
    env_files = [f for f in files if re.search(r"(^|/)\.env($|\.)", f) and not f.endswith(".example")]
    record("public repo", "FAIL" if env_files else "PASS", "no .env file", ", ".join(env_files) or "none")
    keys = []
    for f in files:
        if (ROOT / f).resolve() == SELF:
            continue
        text = read_text(f)
        if text and KEY_RX.search(text):
            keys.append(f)
    record("public repo", "FAIL" if keys else "PASS", "no private key or PEM block in a published file", ", ".join(keys) or "none")
    names, pats = planning_patterns()
    if not names:
        record("public repo", "PASS", "no private planning-note name", "no planning folder next to the repository: nothing to compare")
    else:
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
    # the history goes public with the files: a name or a key a later commit removed is still in it
    in_history, key_commits, commits = history_hits(pats)
    if names:
        found = {p for ps in in_history.values() for p in ps}
        record("public repo", "FAIL" if in_history else "PASS", "no private planning-note name in the git history",
               (f"{len(found)} pattern(s) of the planning-note names in {len(in_history)} commit(s): {', '.join(sorted(in_history))} (names not spelled "
                "out here; git log --all -S<name> shows them). Rewrite those commits, or decide to publish them, before the repository goes public")
               if in_history else f"{commits} commits, {len(names)} names")
    record("public repo", "FAIL" if key_commits else "PASS", "no private key or PEM block in the git history",
           ("added or removed in " + ", ".join(key_commits)) if key_commits else f"{commits} commits scanned (git log --all -p)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--online", action="store_true", help="also fetch the live app, the docs' external links, each video's oEmbed record and both directories' code")
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
    check_fixtures(deployments)
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
