#!/usr/bin/env node
// Mutation check for src/Letterlock.sol. Each mutant below is one hand-written fault. The script applies it to a
// scratch copy of contracts/ (never to this tree), runs the unit, fuzz, invariant and deploy tests there, and reports
// whether any test failed (KILLED) or none did (SURVIVED).
//
//   node contracts/script/mutate.mjs                  # every mutant, 4 at a time
//   node contracts/script/mutate.mjs --jobs 8 --only 1,4 --verbose
//
// Run counts are reduced for speed (fuzz 256, invariant 32 runs); FOUNDRY_FUZZ_RUNS / FOUNDRY_INVARIANT_RUNS override
// them. Excluded: the mainnet fork tests (network) and the gas benchmarks (they measure, they do not check behavior).
// Exit 1 if a mutant not marked `equivalent` survives, if one marked `equivalent` is killed (the note is stale), or if
// a mutant's `find` text does not occur exactly once in the source.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const contracts = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "src/Letterlock.sol";
const original = readFileSync(join(contracts, SRC), "utf8");

const TS = "        // casting to 'uint64' is safe because block.timestamp stays below 2^64 for ~5.8e11 years\n"
  + "        // forge-lint: disable-next-line(unsafe-typecast)\n";

/** [name, find, replace, equivalent?] — `find` must occur exactly once in src/Letterlock.sol. */
const MUTANTS = [
  // epochs (audit A finding 1)
  ["epoch: any higher epoch accepted (the pre-audit rule)",
    "if (uint256(given) != uint256(current) + 1) revert", "if (given <= current) revert"],
  ["epoch: next is + 2", "uint256(current) + 1)", "uint256(current) + 2)"],
  ["epoch: the current epoch is accepted again",
    "if (uint256(given) != uint256(current) + 1) revert", "if (uint256(given) != uint256(current) + 1 && given != current) revert"],
  ["epoch: + 1 in uint32, which overflows at 2^32 - 1",
    "if (uint256(given) != uint256(current) + 1) revert", "if (given != current + 1) revert"],
  ["publish: epoch check removed",
    "Key storage k = _keys[msg.sender];\n        _checkNextEpoch(k.epoch, epoch);", "Key storage k = _keys[msg.sender];"],
  ["publishForAgent: epoch check removed",
    "AgentKey storage k = _agentKeys[agentId];\n        _checkNextEpoch(k.epoch, epoch);", "AgentKey storage k = _agentKeys[agentId];"],
  // agent access control and resolution
  ["publishForAgent: owner check removed", "if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);", ""],
  ["publishForAgent: any existing agent", "if (_ownerOf(agentId) != msg.sender) revert", "if (_ownerOf(agentId) == address(0)) revert"],
  ["publishForAgent: NO_AGENT accepted", "if (agentId == NO_AGENT) revert AgentIdReserved();", ""],
  ["publishForAgent: disabled-path check removed",
    "if (address(identityRegistry) == address(0)) revert AgentPathDisabled();\n        if (agentId == NO_AGENT)", "if (agentId == NO_AGENT)"],
  ["publishForAgent: key check removed",
    "revert NotAgentOwner(agentId, msg.sender);\n        _checkKey(pub);", "revert NotAgentOwner(agentId, msg.sender);"],
  ["publishForAgent: publisher not recorded", "k.publisher = msg.sender;", ""],
  ["publishForAgent: updatedAt not set", `k.updatedAt = uint64(block.timestamp);\n        k.publisher`, "k.publisher"],
  ["resolve: empty record resolves", "return k.epoch != 0 && _ownerOf(agentId) == k.publisher;", "return _ownerOf(agentId) == k.publisher;"],
  ["resolve: publisher ignored (a previous owner's key resolves)",
    "return k.epoch != 0 && _ownerOf(agentId) == k.publisher;", "return k.epoch != 0;"],
  ["resolve: failed ownerOf reads as tx.origin", "owner = address(0);\n        }", "owner = tx.origin;\n        }"],
  ["keyOfAgent: resolution skipped", "if (!_agentKeyResolves(agentId, k)) return (0, 0, 0);", ""],
  ["agentKeyRecord: publisher hidden", "return (k.pub, k.epoch, k.updatedAt, k.publisher);", "return (k.pub, k.epoch, k.updatedAt, address(0));"],
  // address keys
  ["publish: key check removed",
    "function publish(bytes32 pub, uint32 epoch) external {\n        _checkKey(pub);", "function publish(bytes32 pub, uint32 epoch) external {"],
  ["publish: updatedAt not set",
    `${TS}        k.updatedAt = uint64(block.timestamp);\n        emit KeyPublished(msg.sender, NO_AGENT`, "        emit KeyPublished(msg.sender, NO_AGENT"],
  ["publish: event says agent 0", "emit KeyPublished(msg.sender, NO_AGENT, pub, epoch);", "emit KeyPublished(msg.sender, 0, pub, epoch);"],
  ["keyOf: updatedAt dropped",
    "Key storage k = _keys[who];\n        return (k.pub, k.epoch, k.updatedAt);", "Key storage k = _keys[who];\n        return (k.pub, k.epoch, 0);"],
  // drop
  ["drop: both recipient kinds accepted", "if (toAddress == (toAgent != NO_AGENT)) revert", "if (toAddress && (toAgent != NO_AGENT)) revert"],
  ["drop: empty envelope accepted", "if (envelope.length == 0) revert EmptyEnvelope();", ""],
  ["drop: limit is exclusive", "if (envelope.length > MAX_ENVELOPE_BYTES)", "if (envelope.length >= MAX_ENVELOPE_BYTES)"],
  ["drop: checks the sender's key", "if (_keys[to].epoch == 0) revert NoKeyPublished", "if (_keys[msg.sender].epoch == 0) revert NoKeyPublished"],
  ["drop: agent ownership ignored", "if (!_agentKeyResolves(toAgent, _agentKeys[toAgent])) revert", "if (_agentKeys[toAgent].epoch == 0) revert"],
  ["drop: disabled-path check removed",
    "if (address(identityRegistry) == address(0)) revert AgentPathDisabled();\n            if (!_agentKeyResolves", "if (!_agentKeyResolves"],
  ["drop: event says agent 0", "emit Dropped(to, toAgent, envelope);", "emit Dropped(to, 0, envelope);"],
  // key rules
  ["key: zero accepted by the zero check", "if (pub == bytes32(0)) revert ZeroKey();", ""],
  ["key: bit-255 mask not applied", "bytes32 m = pub & ~bytes32(U_BIT_255);", "bytes32 m = pub;"],
  ["key: small-order entry 3 (order 8) dropped", "|| m == SMALL_ORDER_3 ", "|| false "],
  ["key: small-order entry 4 (p - 1) dropped", "m == SMALL_ORDER_4\n", "false\n"],
  ["key: small-order entry 5 (p) dropped", "|| m == SMALL_ORDER_5 ", "|| false "],
  ["key: small-order entry 6 (p + 1) dropped", "|| m == SMALL_ORDER_6", "|| false"],
  ["key: bit 255 allowed", "if (w & U_BIT_255 != 0 || (", "if ((false) || ("],
  ["key: u >= p tested on the wrong byte", "uint8(pub[0]) >= 0xed", "uint8(pub[31]) >= 0xed"],
  ["key: u >= p boundary moved to 0xf0", "uint8(pub[0]) >= 0xed", "uint8(pub[0]) >= 0xf0"],
  ["key: u >= p boundary moved to > 0xed", "uint8(pub[0]) >= 0xed", "uint8(pub[0]) > 0xed",
    "u = p is also libsodium small-order entry 5 (with and without bit 255), rejected before this line"],
  ["key: p constant wrong", "P_BYTES_1_TO_31 = ((1 << 248) - 1) ^ 0x80;", "P_BYTES_1_TO_31 = ((1 << 248) - 1);"],
  // constructor
  ["constructor: registry without code accepted",
    "if (registry != address(0) && registry.code.length == 0) revert RegistryHasNoCode(registry);", ""],
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const jobs = Math.max(1, Number(opt("jobs", "4")));
const only = opt("only") ? new Set(opt("only").split(",").map(Number)) : null;
const verbose = argv.includes("--verbose");
const env = {
  ...process.env,
  FOUNDRY_FUZZ_RUNS: process.env.FOUNDRY_FUZZ_RUNS ?? "256",
  FOUNDRY_INVARIANT_RUNS: process.env.FOUNDRY_INVARIANT_RUNS ?? "32",
};
const FORGE_ARGS = ["test", "--color", "never",
  "--no-match-path", "test/LetterlockGas.t.sol", "--no-match-contract", "LetterlockMainnetForkTest"];
const TIMEOUT_MS = 15 * 60 * 1000;

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "letterlock-mutate-"));
  for (const p of ["foundry.toml", "src", "test", "script"]) cpSync(join(contracts, p), join(dir, p), { recursive: true });
  symlinkSync(join(contracts, "lib"), join(dir, "lib"));
  return dir;
}

function forgeTest(dir) {
  return new Promise((done) => {
    const child = spawn("forge", FORGE_ARGS, { cwd: dir, env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, timedOut: signal === "SIGKILL", out });
    });
  });
}

const fails = (out) => [...new Set(out.split("\n").filter((l) => l.startsWith("[FAIL")).map((l) => l.replace(/\s*\((gas|runs):.*$/, "")))];

const todo = MUTANTS.map((m, i) => ({ id: i + 1, name: m[0], find: m[1], replace: m[2], equivalent: m[3] }))
  .filter((m) => !only || only.has(m.id));
const bad = todo.filter((m) => original.split(m.find).length !== 2);
if (bad.length) {
  for (const m of bad) console.error(`#${m.id} ${m.name}: find text occurs ${original.split(m.find).length - 1} times, not once`);
  process.exit(1);
}

const dirs = Array.from({ length: Math.min(jobs, todo.length) }, workdir);
try {
  const base = await forgeTest(dirs[0]);
  if (base.code !== 0) {
    console.error("the unmutated suite fails, so no mutant can be judged:\n" + fails(base.out).join("\n"));
    process.exit(2);
  }
  console.log(`baseline passes; ${todo.length} mutants, ${dirs.length} at a time (fuzz ${env.FOUNDRY_FUZZ_RUNS} runs, invariant ${env.FOUNDRY_INVARIANT_RUNS} runs)`);

  const results = [];
  const queue = [...todo];
  await Promise.all(dirs.map(async (dir) => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      writeFileSync(join(dir, SRC), original.replace(m.find, m.replace));
      const r = await forgeTest(dir);
      const compileError = /Compiler run failed|Compilation failed/.test(r.out);
      const status = compileError ? "INVALID" : r.timedOut ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED";
      const why = compileError ? "does not compile" : r.timedOut ? "timeout" : fails(r.out);
      results.push({ ...m, status, why });
      const first = Array.isArray(why) ? (why[0] ?? "") : why;
      console.log(`#${String(m.id).padStart(2)} ${status.padEnd(8)} ${m.name}${first ? `  <- ${first}` : ""}`);
      if (verbose && Array.isArray(why)) for (const f of why.slice(1)) console.log(`${" ".repeat(13)}${f}`);
    }
  }));

  results.sort((a, b) => a.id - b.id);
  const killed = results.filter((r) => r.status === "KILLED");
  const survived = results.filter((r) => r.status === "SURVIVED");
  const unexpected = [
    ...survived.filter((r) => !r.equivalent).map((r) => `#${r.id} survived: ${r.name}`),
    ...killed.filter((r) => r.equivalent).map((r) => `#${r.id} is marked equivalent but was killed: ${r.name}`),
    ...results.filter((r) => r.status === "INVALID").map((r) => `#${r.id} does not compile: ${r.name}`),
  ];
  console.log(`\nkilled ${killed.length} of ${results.length}`);
  for (const r of survived.filter((s) => s.equivalent)) console.log(`equivalent survivor #${r.id} (${r.name}): ${r.equivalent}`);
  for (const u of unexpected) console.log(`UNEXPECTED ${u}`);
  process.exitCode = unexpected.length ? 1 : 0;
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
