"""scripts/check_submission_readiness.py on planted inputs: each check must catch what it exists to catch, and pass what
it must not flag. Run by `pnpm verify` (the readiness step): python3 -m unittest discover -s scripts/test -p "test_*.py".

The placeholder words this file plants are assembled at run time, so the file itself stays clean for the scan it tests.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("readiness", HERE.parent / "check_submission_readiness.py")
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

MARK = "TO" + "DO"
FIX = "FIX" + "ME"
LOWER_MARK = MARK.lower()
XS = "0x" + "X" * 40
SOON = "coming" + " soon"
SLOT = "<YOUR_" + "EMAIL>"
EXAMPLE = "https://" + "example" + ".com/replace-me"
WATCH = "https://www.you" + "tube.com/watch?v="
SHORT = "https://you" + "tu.be/"


def summary(p50: float, p95: float, p99: float, lo: float, hi: float, mean: float, n: int = 1000) -> dict:
    return {"n": n, "min": lo, "p50": p50, "p95": p95, "p99": p99, "max": hi, "mean": mean}


# bench/results.json as scripts/bench.ts writes it (schema 2: pooled over the runs, and each run on its own)
BENCH = {
    "schema": 2,
    "latencyMs": {
        "resolve": summary(19.355, 20.478, 21.357, 17.729, 156.13, 20.758),
        "seal": summary(3.592, 5.915, 8.389, 2.002, 18.388, 3.858),
        "resolveAndSeal": summary(23.117, 26.303, 31.221, 20.106, 72.981, 23.627),
        "rpcRoundTrip": summary(19.614, 21.181, 23.161, 17.213, 28.929, 19.183),
        "coldFirstResolve": summary(104.998, 148.7, 148.7, 99.8, 148.7, 117.8, n=5),
    },
    "spread": {"resolveAndSeal": {"p50": {"min": 23.117, "median": 25.637, "max": 29.435}}},
    "runs": [
        {"latencyMs": {"resolveAndSeal": summary(23.117, 26.0, 30.0, 20.1, 50.0, 23.5, 200)}},
        {"latencyMs": {"resolveAndSeal": summary(29.435, 33.0, 38.0, 22.0, 60.0, 29.9, 200)}},
        {"latencyMs": {"resolveAndSeal": summary(25.637, 28.0, 32.0, 21.0, 55.0, 25.9, 200)}},
    ],
}


def problems(md: str, bench: dict = BENCH) -> list[str]:
    return R.latency_problems(md, bench)[2]


class LatencyFigures(unittest.TestCase):
    def test_understated_or_misattributed_figures_fail(self):
        self.assertEqual(len(problems("resolve + seal p50 20 ms, p95 21 ms, p99 24 ms")), 3)
        self.assertEqual(len(problems("resolve + seal p50/p95/p99: 9.9/9.9/9.9 ms")), 3)
        self.assertEqual(len(problems("resolve + seal: 5.5 ms at the median (p50)")), 1)
        table = "| Operation | p50 | p95 | p99 |\n|---|---|---|---|\n| resolve + seal | 5.0 ms | 6.0 ms | 7.0 ms |\n"
        self.assertEqual(len(problems(table)), 3)
        # 17.7 is the minimum of resolve, never the p50 of resolve + seal; 20.106 is resolve + seal's own minimum
        self.assertEqual(len(problems("resolve + seal p50 17.7 ms")), 1)
        self.assertEqual(len(problems("resolve + seal p50 20.106 ms")), 1)

    def test_figures_equal_to_results_pass_at_any_rounding(self):
        for md in ("**resolve + seal: p50 23.117 ms · p95 26.303 ms · p99 31.221 ms** over N = 1,000",
                   "resolve + seal p50 23.1 ms, p95 26.3 ms, p99 31.2 ms",
                   "resolve + seal p50/p95/p99: 23.1/26.3/31.2 ms",
                   "23 ms (p50) for resolve + seal",
                   "Sealing alone takes p50 3.592 ms on this machine; the rest is one keyOf read.",
                   "| Operation | p50 | p95 | p99 |\n|---|---|---|---|\n| resolve + seal | 23.117 | 26.303 | 31.221 |\n",
                   "| op | median (ms) |\n|---|---|\n| seal | 3.6 |\n"):
            with self.subTest(md=md):
                checked, _, found = R.latency_problems(md, BENCH)
                self.assertEqual(found, [])
                self.assertGreater(checked, 0)

    def test_a_range_must_span_the_runs(self):
        self.assertEqual(problems("Across runs the resolve + seal p50 ranged 23.1–29.4 ms."), [])
        self.assertEqual(problems("resolve + seal: the p50 moved between 23.117 and 29.435 ms"), [])
        self.assertEqual(len(problems("Across runs the resolve + seal p50 ranged 22.0–29.4 ms.")), 1)
        single_run = {"latencyMs": BENCH["latencyMs"]}
        self.assertIn("holds no runs", problems("the resolve + seal p50 ranged 23.1–29.4 ms", single_run)[0])

    def test_a_figure_must_name_its_operation_and_statistic(self):
        self.assertIn("names no operation and no statistic", problems("Monad blocks arrive every 400 ms.")[0])
        self.assertIn("names no statistic", problems("resolve + seal takes 23 ms")[0])
        self.assertIn("names no operation", problems("p50 23.1 ms")[0])
        self.assertIn("names no statistic", problems("resolve + seal 23 ms, p95 26.3 ms")[0])

    def test_a_paragraph_marked_not_a_bench_figure_is_skipped(self):
        checked, exempt, found = R.latency_problems(f"Monad blocks arrive every 400 ms. {R.EXEMPT}", BENCH)
        self.assertEqual((checked, exempt, found), (0, 1, []))

    def test_code_blocks_check_only_figures_with_a_statistic(self):
        self.assertEqual(problems("```sh\nsleep 100ms\ncurl --max-time 5000ms\n```\n"), [])
        good = "```\n  resolve+seal     n=1000 p50    23.117  p95    26.303  p99    31.221 ms\n```\n"
        self.assertEqual(problems(good), [])
        self.assertEqual(len(problems(good.replace("31.221", "30.000"))), 1)

    def test_schema_1_cold_first_resolve_is_one_sample(self):
        old = {"latencyMs": {**BENCH["latencyMs"], "coldFirstResolve": 104.998}}
        self.assertEqual(problems("The first resolve of a new client took 105 ms.", old), [])
        self.assertIn("names no statistic", problems("The first resolve of a new client took 105 ms.")[0])
        self.assertEqual(problems("The cold first resolve took p50 105.0 ms over 5 runs."), [])

    def test_a_clause_naming_a_lookup_and_a_seal_is_resolve_plus_seal(self):
        # sealing's own p50 is 3.592: quoted for the whole send path it must fail
        self.assertIn("for resolve + seal p50", problems("Look up a key on chain and seal a note to it: 3.6 ms (p50).")[0])
        self.assertEqual(len(problems("Sealing a letter end to end, resolving the key over RPC and then sealing, takes 3.6 ms at the median.")), 1)
        self.assertEqual(problems("Look up a key on chain and seal a note to it: 23.1 ms (p50)."), [])
        self.assertEqual(problems("keyOf and seal together: p50 23.1 ms."), [])
        # a clause that says the figure is one of them alone, or a ';' between them, keeps the nearest operation
        self.assertEqual(problems("Sealing alone takes 3.6 ms (p50), without the keyOf read."), [])
        self.assertEqual(problems("Sealing takes p50 3.592 ms; the rest is one keyOf read."), [])
        self.assertIn("for resolve p50", problems("A key lookup takes p50 3.6 ms.")[0])

    def test_latency_in_other_units_fails_and_msec_or_n_ms_is_read(self):
        self.assertEqual(len(problems("resolve + seal p50: 20 msec")), 1)
        self.assertEqual(problems("resolve + seal p50: 23.1 msec"), [])
        self.assertEqual(len(problems("resolve + seal p50: 20-ms")), 1)
        self.assertIn("write latency in ms", problems("resolve + seal p50: 0.020 s")[0])
        self.assertIn("write latency in ms", problems("Sealing takes 3592 µs at the median.")[0])
        self.assertEqual(problems("Monad blocks land every 0.4 s."), [])  # no operation named: not a latency claim
        self.assertEqual(problems(f"resolve + seal in 0.02 s. {R.EXEMPT}"), [])

    def test_median_across_runs_is_the_runs_spread(self):
        line = "resolve+seal p50 across runs: 23.117 to 29.435 ms (median 25.637 ms)"
        self.assertEqual(problems(line), [])
        self.assertEqual(problems(f"```\n  {line}\n```\n"), [])
        self.assertIn("run p50s", problems(line.replace("25.637", "23.117"))[0])  # the pooled p50 is not the runs' median
        self.assertEqual(problems("resolve + seal p50 23.117 ms, the median of all 1,000 samples"), [])

    def test_rounding_is_half_up_on_the_held_value(self):
        self.assertTrue(R.matches("29.4", 29.435))
        self.assertTrue(R.matches("29", 29.435))
        self.assertFalse(R.matches("29.5", 29.435))
        self.assertTrue(R.matches("23.1170", 23.117))


class Videos(unittest.TestCase):
    def setUp(self):
        R.results.clear()

    def statuses(self):
        return [(status, title) for _, status, title, _ in R.results]

    def test_a_placeholder_id_fails_and_offline_is_never_a_pass(self):
        R.check_videos("demo: " + WATCH + "a" * 11, online=False)
        self.assertIn(("FAIL", "README.md: video ids are real"), self.statuses())
        self.assertIn(("WARN", "README.md: the videos exist"), self.statuses())
        self.assertNotIn("PASS", [s for s, _ in self.statuses()])

    def test_online_asks_the_oembed_endpoint(self):
        asked = []
        R.check_videos(SHORT + "Zb2c9A3xYk0", online=True, status_of=lambda u: asked.append(u) or 400)
        self.assertEqual(asked, ["https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DZb2c9A3xYk0"])
        self.assertIn(("FAIL", "README.md: the videos exist (online, oEmbed)"), self.statuses())
        R.results.clear()
        R.check_videos(WATCH + "Zb2c9A3xYk0 and https://vimeo.com/123456789", online=True, status_of=lambda u: 200)
        self.assertEqual(self.statuses(), [("PASS", "README.md: the videos exist (online, oEmbed)")])

    def test_oembed_endpoints(self):
        self.assertTrue(R.oembed_url("https://vimeo.com/123456789").startswith("https://vimeo.com/api/oembed.json?url="))
        self.assertTrue(R.oembed_url("https://www.loom.com/share/" + "0f" * 16).startswith("https://www.loom.com/v1/oembed?url="))


class Placeholders(unittest.TestCase):
    def test_planted_placeholders_are_found(self):
        readme = "\n".join([f"Agent card owner: {XS} (fill in)", f"Mainnet support {SOON}.", f"Write to {SLOT}.", f"See {EXAMPLE}.", f"{MARK}: the video"])
        hits = R.placeholder_hits("README.md", readme)
        for label in ("README.md:1 " + "X" * 3, f"README.md:2 {SOON}", f"README.md:3 unfilled {SLOT}", "README.md:4 example domain", f"README.md:5 {MARK}"):
            self.assertIn(label, hits)
        code = R.placeholder_hits("scripts/lib/audit-planted.ts", f"const rpc = x; // {LOWER_MARK}: wire the real rpc\n# {FIX.lower()} later\n")
        self.assertEqual(code, [f"scripts/lib/audit-planted.ts:1 {LOWER_MARK} marker"])
        self.assertEqual(R.placeholder_hits("x.py", f"x = 1  # {FIX.lower()} later\n"), [f"x.py:1 {FIX.lower()} marker"])
        self.assertIn("README.md placeholder video id " + "x" * 11, R.placeholder_hits("README.md", SHORT + "x" * 11))

    def test_what_is_not_a_placeholder_passes(self):
        clean = [
            ("scripts/verify.ts", f'  // a "not ok" line with a {LOWER_MARK} directive is not a failure (TAP 13)\n  const skipped = n("{LOWER_MARK}");\n'),
            ("scripts/seed.ts", "  --private-key-env <NAME>    environment variable holding the sender's key\n"),
            ("docs/notes.md", "The key is `0xabc123…` in code, and `<ADDRESS>` in a command.\n\n```\nletterlock seal <ADDRESS>\n```\n"),
            ("scripts/test/rpid.test.ts", f'const rp = "{EXAMPLE}";\n'),
            ("packages/x/src/a.ts", "const token = 'xXq9'; const hex = 0xdeadbeef;\n"),
        ]
        for path, text in clean:
            with self.subTest(path=path):
                self.assertEqual(R.placeholder_hits(path, text), [])

    def test_unfilled_forms_in_markdown_prose_are_found(self):
        planted = ["todo: record the demo", "Team page: Tbd", "Twitter: PLACEHOLDER", "[Pitch deck](#)", "Contact: <your-email>",
                   "Agent card owner: 0x" + "0" * 40, "Discord: [INSERT LINK HERE]", "Rotation UI: WIP", "[Slides]()", "| Pitch video | N/A |"]
        for line in planted:
            with self.subTest(line=line):
                self.assertEqual(len(R.placeholder_hits("README.md", line + "\n")), 1)
        self.assertEqual(R.placeholder_hits("docs/SPEC.md", "owner 0x" + "0" * 40 + "\n"), [])  # only README.md and DEMO.md
        for fine in ("<details><summary>More</summary> <br> <img src=\"x.png\">", "The header is a placeholder, and the page says so.",
                     "See [SPEC](docs/SPEC.md#3) and <https://monad.xyz>.", "`[x](#)` and `<your-email>` in code are notation."):
            with self.subTest(fine=fine):
                self.assertEqual(R.placeholder_hits("README.md", fine + "\n"), [])

    def test_only_generated_json_under_fixtures_is_skipped(self):
        self.assertTrue(R.skipped_from_scan("fixtures/envelopes.json"))
        self.assertTrue(R.skipped_from_scan("fixtures/seeded/143.json"))
        self.assertFalse(R.skipped_from_scan("fixtures/README.md"))
        self.assertFalse(R.skipped_from_scan("apps/demo/qa/report.md"))
        self.assertIn(f"fixtures/README.md:1 {MARK}", R.placeholder_hits("fixtures/README.md", f"{MARK}: owner 0x..."))


class TempRepo(unittest.TestCase):
    """A scratch git repository as ROOT, with a planning folder next to it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "build"
        self.root.mkdir()
        (base / "specs").mkdir()
        (base / "specs" / "alpha-notes.md").write_text("private\n")
        (base / "specs" / "README.md").write_text("index\n")
        self.git("init", "-q")
        self.saved = R.ROOT
        R.ROOT = self.root
        R.results.clear()

    def tearDown(self):
        R.ROOT = self.saved
        R.results.clear()
        self.tmp.cleanup()

    def git(self, *args: str) -> None:
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", *args], cwd=self.root, check=True, capture_output=True)

    def commit(self, path: str, text: str | None) -> None:
        p = self.root / path
        if text is None:
            p.unlink()
            self.git("rm", "-q", path)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
            self.git("add", path)
        self.git("commit", "-q", "-m", f"change {path}")

    def found(self, title: str) -> tuple[str, str]:
        rows = [(s, d) for _, s, t, d in R.results if t == title]
        self.assertEqual(len(rows), 1, f"no single row {title!r}: {R.results}")
        return rows[0]


class History(TempRepo):
    def test_a_planning_name_removed_from_the_files_is_still_in_history(self):
        self.commit("notes.md", "see alpha-notes.md for the plan\n")
        self.commit("notes.md", None)
        self.commit("README.md", "clean\n")
        R.check_public(R.publishable_files())
        self.assertEqual(self.found("no private planning-note name in a published file")[0], "PASS")
        status, detail = self.found("no private planning-note name in the git history")
        self.assertEqual(status, "FAIL")
        self.assertIn("in 2 commit(s)", detail)
        self.assertNotIn("alpha-notes", detail)

    def test_a_planning_name_in_a_commit_message_is_in_history(self):
        self.commit("README.md", "clean\n")
        self.git("commit", "-q", "--allow-empty", "-m", "docs: numbers follow alpha-notes.md section 2")
        R.check_public(R.publishable_files())
        status, detail = self.found("no private planning-note name in the git history")
        self.assertEqual(status, "FAIL")
        self.assertIn("in 1 commit(s)", detail)

    def test_a_private_key_removed_from_the_files_is_still_in_history(self):
        self.commit("config.env.txt", "PRIVATE_KEY=0x" + "ab" * 32 + "\n")
        self.commit("config.env.txt", None)
        R.check_public(R.publishable_files())
        self.assertEqual(self.found("no private key or PEM block in a published file")[0], "PASS")
        self.assertEqual(self.found("no private key or PEM block in the git history")[0], "FAIL")

    def test_a_clean_history_passes(self):
        self.commit("README.md", "clean\n")
        R.check_public(R.publishable_files())
        self.assertEqual(self.found("no private planning-note name in the git history")[0], "PASS")
        self.assertEqual(self.found("no private key or PEM block in the git history")[0], "PASS")


class SeedRecord(TempRepo):
    DIRECTORY = "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e"

    def seeded(self, runs: list[dict]) -> tuple[str, str]:
        (self.root / "fixtures" / "seeded").mkdir(parents=True, exist_ok=True)
        (self.root / "fixtures" / "seeded" / "143.json").write_text(json.dumps({"runs": runs}))
        R.check_fixtures({"143": {"address": self.DIRECTORY}})
        return self.found("a complete mainnet seed run is recorded (fixtures/seeded/143.json)")

    def run_(self, **over) -> dict:
        return {"at": "t", "chainId": 143, "directory": self.DIRECTORY.lower(), "status": "sent and read back: all 5 envelopes",
                "drops": [{"id": str(i)} for i in range(5)], **over}

    def test_a_stopped_run_or_another_directory_is_no_seed(self):
        stopped = self.run_(status='stopped at "dentist": insufficient funds', directory="0x" + "0" * 39 + "1", drops=[])
        status, detail = self.seeded([stopped])
        self.assertEqual(status, "WARN")
        self.assertIn("none complete", detail)
        R.results.clear()
        self.assertEqual(self.seeded([self.run_(directory="0x" + "0" * 39 + "1")])[0], "WARN")
        R.results.clear()
        self.assertEqual(self.seeded([self.run_(drops=[{"id": "1"}])])[0], "WARN")

    def test_a_complete_run_to_the_recorded_directory_passes(self):
        status, detail = self.seeded([self.run_(status="stopped at x"), self.run_()])
        self.assertEqual(status, "PASS")
        self.assertIn("1 complete run(s) of 2", detail)


class Bench(TempRepo):
    def test_failed_calls_or_mismatches_fail_the_bench(self):
        (self.root / "bench").mkdir()
        res = {"generatedAt": "2026-09-27T03:22:54.285Z", "context": {"n": 200, "runs": 5}, "latencyMs": BENCH["latencyMs"],
               "checks": {"failures": [{"round": 3, "op": "resolve", "code": "RETRIED", "message": "2 requests"}], "mismatches": []}}
        (self.root / "bench" / "results.json").write_text(json.dumps(res))
        (self.root / "bench" / "RESULTS.md").write_text("p50 23.117 ms · p95 26.303 ms · p99 31.221 ms\n")
        R.check_bench()
        self.assertEqual(self.found("bench run was clean")[0], "FAIL")
        self.assertEqual(self.found("bench/RESULTS.md was written from results.json")[0], "PASS")
        R.results.clear()
        (self.root / "bench" / "RESULTS.md").write_text("p50 23.117 ms · p95 26.3 ms\n")
        R.check_bench()
        self.assertEqual(self.found("bench/RESULTS.md was written from results.json")[0], "FAIL")


if __name__ == "__main__":
    unittest.main()
