// pnpm verify: every test suite in the repository, then one screen of exact counts, read from each runner's own report.
//
//   pnpm verify                    all steps
//   pnpm verify --only sdk,forge   some steps (sdk, forge, spike, demo, agent, offline, scripts, readiness)
//   pnpm verify --skip forge
//   pnpm verify --json <file>      also write the summary as JSON
//   pnpm verify --markdown <file>  also append it as a Markdown table (CI: $GITHUB_STEP_SUMMARY)
//
// Steps, in order (each runs the package's own test command):
//   sdk      packages/letterlock   pnpm test (vitest: unit tests, and chain tests on anvil when Foundry is installed)
//   forge    contracts             forge test (unit, fuzz, invariant, deploy and gas tests; the Monad mainnet fork tests
//                                  skip, with the reason, when rpc.monad.xyz is unreachable)
//   spike    spikes/prf-browser    pnpm test:unit (node:test; the browser run is pnpm spike:browser)
//   demo     apps/demo             pnpm test (node:test)
//   agent    examples/agent-memory pnpm test (vitest: the reference agent, with its chain tests on anvil)
//   offline  scripts/verify_offline.ts: seal and open with no network (an OS-level block where the machine has one,
//            and the in-process guard that counts attempts), and the fixture replay
//   scripts  scripts/test/*.test.ts (node:test): scripts/seed.ts end to end on anvil, the network guard and the OS
//            block, verify_offline on edited fixture files, and this file's own rules ("seed" is an old name for it)
//   readiness scripts/test/test_*.py (python3 -m unittest): the submission readiness checks, on planted files
// Counts come from vitest's JSON report, forge's --json output, node:test's TAP summary, unittest's summary and
// verify_offline's result line. A step fails when its command exits non-zero, when a test failed, when its counts
// cannot be read, or when no test in it passed: a step whose every test was skipped, or that ran none, is a FAIL, never
// a PASS. The exit code is 1 if any step failed. Full output of every step: the log folder printed at the end.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./lib/git.ts";

export type Counts = { passed: number; failed: number; skipped: number; total: number; notes: string[] };
type Step = {
  key: string;
  name: string;
  cwd: string;
  command: (logDir: string) => string[];
  parse: (output: string, logDir: string) => Counts;
};

/** node:test's TAP summary ("# tests 29", "# pass 29", ...) and its skipped tests ("ok 3 - name # SKIP reason"). */
export const tap = (output: string): Counts => {
  const n = (label: string) => {
    const m = new RegExp(`^# ${label} (\\d+)$`, "m").exec(output);
    if (!m) throw new Error(`no "# ${label}" line in the TAP output`);
    return Number(m[1]);
  };
  const skippedNames = [...output.matchAll(/^\s*ok \d+ - (.+?) # SKIP(?: (.*))?$/gm)].map((m) => `${m[1]}${m[2] ? `: ${m[2]}` : ""}`);
  // a "not ok" line with a todo directive is not a failure (TAP 13)
  const failedNames = [...output.matchAll(/^\s*not ok \d+ - (.+?)( # (?:todo|skip)\b.*)?$/gim)].filter((m) => m[2] === undefined).map((m) => m[1]!);
  const passed = n("pass");
  const failed = n("fail") + n("cancelled");
  const skipped = n("skipped") + n("todo");
  return { passed, failed, skipped, total: n("tests"), notes: [...failedNames.map((f) => `FAILED ${f}`), ...skippedNames.map((s) => `skipped ${s}`)] };
};

/** A vitest package run with its own `pnpm test`, counted from vitest's JSON report. */
const vitest = (key: string, name: string, cwd: string, why: (file: string) => string = () => ""): Step => ({
  key,
  name,
  cwd,
  command: (log) => ["pnpm", "test", "--reporter=dot", "--reporter=json", `--outputFile.json=${join(log, `${key}.json`)}`],
  parse: (_, log) => {
    const r = JSON.parse(readFileSync(join(log, `${key}.json`), "utf8")) as {
      numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number;
      testResults: { name: string; message?: string; assertionResults: { status: string; fullName?: string; title?: string }[] }[];
    };
    const skippedByFile = new Map<string, number>();
    const failedNames: string[] = [];
    for (const f of r.testResults) {
      const file = f.name.slice(f.name.indexOf(`${cwd}/`) + cwd.length + 1);
      const n = f.assertionResults.filter((a) => a.status === "skipped" || a.status === "pending" || a.status === "todo").length;
      if (n) skippedByFile.set(file, n);
      for (const a of f.assertionResults) if (a.status === "failed") failedNames.push(`${file}: ${a.fullName ?? a.title}`);
      if (f.assertionResults.length === 0 && f.message) failedNames.push(`${file}: ${f.message.split("\n")[0]}`); // a file that failed to load
    }
    return {
      passed: r.numPassedTests,
      failed: r.numFailedTests,
      skipped: r.numPendingTests + r.numTodoTests,
      total: r.numTotalTests,
      notes: [...failedNames.map((f) => `FAILED ${f}`), ...[...skippedByFile].map(([file, n]) => `skipped ${n} in ${file}${why(file)}`)],
    };
  },
});

/** python3 -m unittest -v: "Ran 12 tests in 0.1s", then "OK", "OK (skipped=1)" or "FAILED (failures=1, errors=2)". */
export const unittest = (output: string): Counts => {
  const ran = /^Ran (\d+) tests? in /m.exec(output);
  if (!ran) throw new Error('no "Ran N tests" line in the unittest output');
  const summary = /^(OK|FAILED)(?: \((.*)\))?$/m.exec(output.slice(ran.index));
  if (!summary) throw new Error("no OK or FAILED line after it");
  const n = (key: string) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(summary[2] ?? "")?.[1] ?? 0);
  const failed = n("failures") + n("errors") + n("unexpected successes");
  const skipped = n("skipped") + n("expected failures");
  const total = Number(ran[1]);
  const failedNames = [...output.matchAll(/^(?:FAIL|ERROR): (\S+) \((.+?)\)$/gm)].map((m) => m[2]!);
  // "test_b (module.Class.test_b) ... skipped 'why'"; with a docstring, its first line sits between the two
  const lines = output.split("\n");
  const skippedNames = lines.flatMap((l, i) => {
    const why = / \.\.\. skipped '(.*)'$/.exec(l)?.[1];
    if (why === undefined) return [];
    const id = /^\S+ \(([^)]+)\)/.exec(l)?.[1] ?? /^\S+ \(([^)]+)\)$/.exec(lines[i - 1] ?? "")?.[1] ?? "?";
    return [`${id}: ${why}`];
  });
  return { passed: total - failed - skipped, failed, skipped, total, notes: [...failedNames.map((f) => `FAILED ${f}`), ...skippedNames.map((s) => `skipped ${s}`)] };
};

/** Why a step failed, or undefined when it passed: it must exit 0, fail no test, and pass at least one. */
export const stepError = (code: number, counts: Counts | undefined, parseError?: string): string | undefined => {
  if (parseError !== undefined || counts === undefined) return `counts unreadable: ${parseError ?? "no counts"}`;
  if (code !== 0) return `exit code ${code}`;
  if (counts.failed > 0) return `${counts.failed} failed`;
  if (counts.passed === 0) return counts.total === 0 ? "ran no test" : `no test passed (${counts.skipped} skipped)`;
  return undefined;
};

type OfflineResult = {
  checks: number; passed: number; failed: number;
  osBlock?: { tool: string | null; ok: boolean; detail: string };
  fixtures: { cases: number; passed: number; planned?: number };
  roundTrips: number;
  networkAttempts: { probes?: number; probesRefused?: number; refusedProbes: number; duringOfflineWork: number };
  maxPlaintextBytes: number;
};

/** verify_offline's VERIFY_OFFLINE_RESULT line: its checks are the counts; the OS block and the probes are notes. */
export const offline = (output: string): Counts => {
  const m = /^VERIFY_OFFLINE_RESULT (\{.*\})$/m.exec(output);
  if (!m) throw new Error("no VERIFY_OFFLINE_RESULT line");
  const r = JSON.parse(m[1]!) as OfflineResult;
  const a = r.networkAttempts;
  return {
    passed: r.passed,
    failed: r.failed,
    skipped: 0,
    total: r.checks,
    notes: [
      r.osBlock?.tool ? `OS-level network block: ${r.osBlock.detail}` : `no OS-level network block: ${r.osBlock?.detail ?? "not reported"}`,
      `fixture replay ${r.fixtures.passed}/${r.fixtures.cases}${r.fixtures.planned !== undefined ? ` of ${r.fixtures.planned} planned` : ""} (fixtures/envelopes.json), ` +
        `${r.roundTrips} round trips to cached keys`,
      `${a.probesRefused ?? "?"} of ${a.probes ?? "?"} ways out refused in-process (${a.refusedProbes} attempts counted), ${a.duringOfflineWork} attempts during the offline work`,
    ],
  };
};

const STEPS: Step[] = [
  vitest("sdk", "SDK: unit + anvil (vitest)", "packages/letterlock",
    (file) => (file.endsWith("live.test.ts") ? " (read-only checks against the live Monad RPCs: pnpm --filter letterlock test:live)" : "")),
  {
    key: "forge",
    name: "Contracts (forge test)",
    cwd: "contracts",
    command: () => ["forge", "test", "--json"],
    parse: (output) => {
      const start = output.indexOf("{");
      if (start < 0) throw new Error("no JSON in forge's output");
      const suites = JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)) as Record<string, { test_results: Record<string, { status: string; reason: string | null }> }>;
      const c: Counts = { passed: 0, failed: 0, skipped: 0, total: 0, notes: [] };
      for (const [suite, s] of Object.entries(suites)) {
        for (const [test, t] of Object.entries(s.test_results)) {
          c.total++;
          if (t.status === "Success") c.passed++;
          else if (t.status === "Skipped") { c.skipped++; c.notes.push(`skipped ${suite.split(":").pop()}.${test}${t.reason ? `: ${t.reason}` : ""}`); }
          else { c.failed++; c.notes.push(`FAILED ${suite.split(":").pop()}.${test}${t.reason ? `: ${t.reason}` : ""}`); }
        }
      }
      return c;
    },
  },
  { key: "spike", name: "PRF spike: unit (node:test)", cwd: "spikes/prf-browser", command: () => ["pnpm", "test:unit"], parse: tap },
  { key: "demo", name: "Demo app (node:test)", cwd: "apps/demo", command: () => ["pnpm", "test"], parse: tap },
  vitest("agent", "Reference agent (vitest)", "examples/agent-memory"),
  { key: "offline", name: "Offline seal/open, no network", cwd: ".", command: () => ["node", "scripts/verify_offline.ts"], parse: offline },
  {
    key: "scripts",
    name: "Scripts: seed, guards (node:test)",
    cwd: ".",
    command: () => ["node", "--test", "--test-reporter=tap", "scripts/test/*.test.ts"],
    parse: tap,
  },
  {
    key: "readiness",
    name: "Readiness checks (unittest)",
    cwd: ".",
    command: () => ["python3", "-m", "unittest", "discover", "-s", "scripts/test", "-p", "test_*.py", "-v"],
    parse: unittest,
  },
];
/** Old step names --only and --skip still take. */
const ALIASES: Record<string, string> = { seed: "scripts" };

const main = async () => {
  const { values: opts } = parseArgs({ options: { only: { type: "string" }, skip: { type: "string" }, json: { type: "string" }, markdown: { type: "string" } } });
  const keys = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean).map((k) => ALIASES[k] ?? k) : undefined);
  const only = keys(opts.only);
  const skip = keys(opts.skip) ?? [];
  for (const k of [...(only ?? []), ...skip]) if (!STEPS.some((s) => s.key === k)) throw new Error(`no step "${k}": the steps are ${STEPS.map((s) => s.key).join(", ")}`);
  const selected = STEPS.filter((s) => (only ? only.includes(s.key) : true) && !skip.includes(s.key));

  const logDir = mkdtempSync(join(tmpdir(), "letterlock-verify-"));
  const run = (step: Step): Promise<{ code: number; output: string; ms: number }> =>
    new Promise((resolve) => {
      const [cmd, ...args] = step.command(logDir);
      const log = createWriteStream(join(logDir, `${step.key}.log`));
      const t0 = performance.now();
      const p = spawn(cmd!, args, { cwd: join(ROOT, step.cwd), env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const take = (d: Buffer) => { chunks.push(d); log.write(d); };
      p.stdout.on("data", take);
      p.stderr.on("data", take);
      p.on("error", (e) => { take(Buffer.from(`\n${e.message}\n`)); });
      p.on("close", (code) => { log.end(); resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString(), ms: performance.now() - t0 }); });
    });

  const git = (...args: string[]) => new Promise<string>((resolve) => {
    const p = spawn("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
  const forgeVersion = await new Promise<string>((resolve) => {
    const p = spawn("forge", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", () => resolve(/forge Version: (\S+)/.exec(out)?.[1] ?? "not found"));
    p.on("error", () => resolve("not found"));
  });
  const head = await git("rev-parse", "--short", "HEAD");
  const dirty = (await git("status", "--porcelain")) !== "";

  type Row = { key: string; name: string; ok: boolean; counts?: Counts; ms: number; error?: string };
  const rows: Row[] = [];
  const started = new Date();
  console.log(`verify: ${selected.length} steps; full output in ${logDir}`);
  for (const [i, step] of selected.entries()) {
    const r = await run(step);
    let counts: Counts | undefined;
    let parseError: string | undefined;
    try { counts = step.parse(r.output, logDir); } catch (e) { parseError = (e as Error).message; }
    const error = stepError(r.code, counts, parseError);
    const ok = error === undefined;
    rows.push({ key: step.key, name: step.name, ok, ms: r.ms, ...(counts ? { counts } : {}), ...(error ? { error } : {}) });
    console.log(`  [${i + 1}/${selected.length}] ${step.name}: ${ok ? "PASS" : `FAIL (${error})`}${counts ? `, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped` : ""} (${(r.ms / 1000).toFixed(1)}s)`);
    if (!ok) {
      const failures = counts?.notes.filter((n) => n.startsWith("FAILED")) ?? [];
      // the failing tests by name when the runner reported them, else the end of the output
      const shown = failures.length ? failures.slice(0, 8) : r.output.trimEnd().split("\n").slice(-12);
      console.log([...shown.map((l) => `      | ${l}`), `      | log: ${join(logDir, `${step.key}.log`)}`].join("\n"));
    }
  }

  const pad = (s: string | number, n: number, left = false) => (left ? String(s).padEnd(n) : String(s).padStart(n));
  const total = rows.reduce((t, r) => ({
    passed: t.passed + (r.counts?.passed ?? 0), failed: t.failed + (r.counts?.failed ?? 0),
    skipped: t.skipped + (r.counts?.skipped ?? 0), total: t.total + (r.counts?.total ?? 0), ms: t.ms + r.ms,
  }), { passed: 0, failed: 0, skipped: 0, total: 0, ms: 0 });
  const allOk = rows.every((r) => r.ok) && rows.length > 0;
  const line = (name: string, result: string, c: { passed: number; failed: number; skipped: number; total: number } | undefined, ms?: number) =>
    `  ${pad(name, 34, true)} ${pad(result, 6, true)} ${pad(c?.passed ?? "-", 6)} ${pad(c?.failed ?? "-", 6)} ${pad(c?.skipped ?? "-", 6)} ${pad(c?.total ?? "-", 6)} ${pad(ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`, 7)}`;
  console.log([
    "",
    `Letterlock verify · ${started.toISOString().slice(0, 16).replace("T", " ")} UTC · node ${process.version} · forge ${forgeVersion} · ${head}${dirty ? " with uncommitted changes" : ""}`,
    "",
    `  ${pad("step", 34, true)} ${pad("result", 6, true)} ${pad("passed", 6)} ${pad("failed", 6)} ${pad("skip", 6)} ${pad("total", 6)} ${pad("time", 7)}`,
    ...rows.map((r) => line(r.name, r.ok ? "PASS" : "FAIL", r.counts, r.ms)),
    `  ${"-".repeat(34)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(7)}`,
    line("all steps", allOk ? "PASS" : "FAIL", total, total.ms),
    ...(skip.length || only ? [`  not run: ${STEPS.filter((s) => !selected.includes(s)).map((s) => s.key).join(", ")}`] : []),
    "",
    ...rows.flatMap((r) => [
      ...(r.error ? [`  ${r.key}: FAIL, ${r.error} (log: ${join(logDir, `${r.key}.log`)})`] : []),
      ...(r.counts?.notes ?? []).slice(0, 6).map((n) => `  ${r.key}: ${n}`),
      ...((r.counts?.notes.length ?? 0) > 6 ? [`  ${r.key}: ... ${r.counts!.notes.length - 6} more in ${join(logDir, `${r.key}.log`)}`] : []),
    ]),
  ].join("\n"));

  if (opts.markdown) {
    const cell = (r: Row) => [r.counts?.passed ?? "-", r.counts?.failed ?? "-", r.counts?.skipped ?? "-", r.counts?.total ?? "-"].join(" | ");
    appendFileSync(opts.markdown, [
      `### pnpm verify: ${allOk ? "PASS" : "FAIL"}`,
      "",
      `node ${process.version} · forge ${forgeVersion} · ${head}${dirty ? " with uncommitted changes" : ""}`,
      "",
      "| step | result | passed | failed | skipped | total |",
      "|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.name} | ${r.ok ? "PASS" : `FAIL: ${r.error}`} | ${cell(r)} |`),
      `| **all steps** | **${allOk ? "PASS" : "FAIL"}** | ${total.passed} | ${total.failed} | ${total.skipped} | ${total.total} |`,
      "",
      ...rows.flatMap((r) => (r.counts?.notes ?? []).map((n) => `- ${r.key}: ${n}`)),
      "",
    ].join("\n"));
  }
  if (opts.json) {
    writeFileSync(opts.json, `${JSON.stringify({ startedAt: started.toISOString(), node: process.version, forge: forgeVersion, head, dirty, ok: allOk, total, steps: rows }, null, 2)}\n`);
  }
  process.exitCode = allOk ? 0 : 1;
};

if (import.meta.main) await main();
