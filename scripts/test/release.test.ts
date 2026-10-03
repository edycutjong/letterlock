// scripts/release.ts: which commits release, how far, and the release notes; scripts/version-sync.ts: the stamps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpOf, nextVersion, notes, section } from "../release.ts";
import { RULES, stamp } from "../version-sync.ts";

const c = (subject: string, body = "") => ({ sha: "a".repeat(40), subject, body });

test("a docs, test, chore or release commit releases nothing", () => {
  for (const s of ["docs: x", "test(sdk): x", "chore: x", "ci: x", "chore(release): v0.1.2", "Merge branch x"]) assert.equal(bumpOf(c(s)), undefined, s);
});

test("fix and perf are patch, feat is minor, a bang or a BREAKING CHANGE footer is major", () => {
  assert.equal(bumpOf(c("fix(sdk): x")), "patch");
  assert.equal(bumpOf(c("perf: x")), "patch");
  assert.equal(bumpOf(c("feat(cli): x")), "minor");
  assert.equal(bumpOf(c("feat(sdk)!: x")), "major");
  assert.equal(bumpOf(c("fix: x", "BREAKING CHANGE: the rpId moves")), "major");
});

test("below 1.0.0 a breaking change is minor, so 0.x never becomes 1.0.0 by itself", () => {
  assert.deepEqual(nextVersion("0.1.1", [c("fix: a")]), { bump: "patch", next: "0.1.2" });
  assert.deepEqual(nextVersion("0.1.1", [c("fix: a"), c("feat: b")]), { bump: "minor", next: "0.2.0" });
  assert.deepEqual(nextVersion("0.1.1", [c("feat(sdk)!: c")]), { bump: "minor", next: "0.2.0" });
  assert.deepEqual(nextVersion("1.2.3", [c("feat(sdk)!: c")]), { bump: "major", next: "2.0.0" });
  assert.equal(nextVersion("0.1.1", [c("docs: d")]), undefined);
});

test("the release notes are the version's CHANGELOG section", () => {
  const sec = section("0.2.0", "2026-10-03", [c("feat(sdk): sealMany"), c("fix: kid check")]);
  assert.match(sec, /^## 0\.2\.0 \(2026-10-03\)/);
  assert.match(sec, /\*\*Features\*\*\n\n- sealMany \(\[aaaaaaa\]/);
  const changelog = `# Changelog\n\n${sec}\n## 0.1.1 (2026-09-28)\n\n- old\n`;
  assert.match(notes("0.2.0", changelog), /^\*\*Features\*\*/);
  assert.equal(notes("0.1.1", changelog), "- old");
  assert.throws(() => notes("9.9.9", changelog));
});

test("a stamp replaces only the version it names", () => {
  const footer = RULES.find((r) => r.what === "slide footers")!;
  const r = stamp('<span class="wm">Letter<em>lock</em></span><span>v0.1.0 · Monad Metropolis 2026 · Track 04</span>', footer, "0.2.0");
  assert.equal(r.text, '<span class="wm">Letter<em>lock</em></span><span>v0.2.0 · Monad Metropolis 2026 · Track 04</span>');
  assert.deepEqual(r.found, ["0.1.0"]);
  const link = RULES.find((r) => r.what === "footer release link")!;
  const l = stamp('<a href="https://github.com/edycutjong/letterlock/releases/tag/v0.1.1" data-release>Release v0.1.1</a>', link, "0.2.0");
  assert.equal(l.text, '<a href="https://github.com/edycutjong/letterlock/releases/tag/v0.2.0" data-release>Release v0.2.0</a>');
  const card = RULES.find((r) => r.what === "agent card version")!;
  const k = stamp('{\n  "version": "1.0.0",\n  "x": { "version": "1" }\n}', card, "0.1.1");
  assert.equal(k.text, '{\n  "version": "0.1.1",\n  "x": { "version": "1" }\n}');
  assert.equal(k.matches, 1);
});
