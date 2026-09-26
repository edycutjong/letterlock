// The tester's instructions are part of the experiment: a README that over-reads one run would turn a scoped
// result into a general claim. These checks pin the scoping, and that every verdict the README quotes is one the
// page can actually show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "..");
const readme = readFileSync(join(dir, "README.md"), "utf8");
const pageText = ["verdict.ts", "main.ts", "index.html"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
const rows = readme.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
const row = (start: string) => rows.find((l) => l.startsWith(start)) ?? "";

test("both known Apple issues are cited: hybrid PRF (774112) and synced copies by direction and OS version (822523)", () => {
  assert.match(readme, /\(https:\/\/developer\.apple\.com\/forums\/thread\/774112\)/);
  assert.match(readme, /\(https:\/\/developer\.apple\.com\/forums\/thread\/822523\)/);
  assert.match(readme, /iPhone → Mac: PRF outputs differ\. Mac → iPhone: PRF outputs match\./);
});

test("prerequisites demand the same OS generation, exact versions, and a label for a mixed pair", () => {
  const before = readme.slice(readme.indexOf("## Before you start"), readme.indexOf("## Steps"));
  assert.match(before, /The same OS generation on both devices/);
  assert.match(before, /Note the\s+exact versions/);
  assert.match(before, /label the result \*\*mixed versions\*\*/);
});

test("the PASS row claims one direction on these OS versions, nothing more", () => {
  const pass = row("| iPad: **PASS**");
  assert.match(pass, /On these two OS versions, a passkey created on the Mac re-derived the identical key on this iPad/);
  assert.match(pass, /says nothing about the reverse direction or about other OS versions/);
  assert.doesNotMatch(readme, /claim holds/);
});

test("the cross-device FAIL row is qualified by OS generation", () => {
  const fail = row("| **FAIL**: *Same passkey as the other device");
  assert.match(fail, /different OS generations.*thread 822523 rather than a Letterlock defect/);
  assert.match(fail, /same OS generation.*claim fails for that direction/);
});

test("the Mac self-check, the optional reverse run, and the hybrid open that does not count are all documented", () => {
  assert.match(readme, /\*\*Self-check:\*\* tap \*\*2 · Use my passkey\*\* once, on the Mac/);
  assert.match(readme, /## Optional reverse run \(iPad → Mac\)/);
  assert.match(row("| **RETRY**: *The note opened, but through ANOTHER device"), /does \*\*not\*\* count as a PASS/);
});

test("every verdict the README's table quotes is text the page can show", () => {
  const quoted = rows.map((l) => l.split("|")[1] ?? "").flatMap((cell) => [...cell.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/g)].map((m) => m[1]!.replace(/…$/, "")));
  assert.ok(quoted.length >= 7, `expected the table to quote the verdicts, found ${quoted.length}`);
  for (const q of quoted) assert.ok(pageText.includes(q), `README quotes a verdict the page never shows: “${q}”`);
  assert.ok(pageText.includes("discoverable — no passkey hint saved in this browser"));
});
