// What the README, the agent card, the page and docs/SPEC.md say about the agent must be what the code does: the
// in-memory limits and the replay guard are per server instance, the firewall rule is vercel-firewall.json's, the
// gas cap, the day's share and the web origins are the config's, and §2 names the key this agent derives.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_LIMITS } from "../src/config.ts";
import { QUOTE_CHARS } from "../src/task.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readme = read("README.md");
const page = read("public/index.html");
const card = JSON.parse(read("public/.well-known/agent-card.json")) as {
  skills: { id: string; description: string }[];
  letterlock: { limits: Record<string, unknown> };
};
const limits = card.letterlock.limits;
const firewall = JSON.parse(read("vercel-firewall.json")) as { rules: { conditionGroup: unknown; action: { mitigate: { action: string; rateLimit: Record<string, unknown> } } }[] };
const spec = read("../../docs/SPEC.md");
const docs = [["README.md", readme], ["public/index.html", page], ["agent-card.json", JSON.stringify(card)]] as const;

describe("the docs say what the code does", () => {
  it("every limit kept in memory is described as per server instance and best effort, and no doc says a nonce is answered once without it", () => {
    expect(limits.dropsPerIp).toMatch(/counted in each server instance's memory: best effort/);
    expect(limits.taskNonce).toBe("each nonce is answered once per server instance, for 12 minutes");
    expect(page).toMatch(/counted in each server instance's\s+memory: best effort/);
    expect(readme).toContain("| Drops per IP | 5 per 10 minutes, 20 per day | each server instance's memory, best effort");
    expect(readme).toContain("| Requests per IP | 60 per minute | each server instance's memory, best effort |");
    for (const [name, text] of docs)
      for (const m of text.matchAll(/(each nonce|nonce is answered|nonces? (are|is) answered)[^.;"]*/gi))
        expect(m[0], `${name}: ${m[0]}`).toMatch(/once per server instance|in each instance's memory|once already/);
  });

  it("the firewall rule is the one the docs describe: 5 POST requests per IP per 10 minutes, fixed window", () => {
    expect(firewall.rules).toHaveLength(1);
    const rule = firewall.rules[0]!;
    expect(rule.conditionGroup).toEqual([{ conditions: [{ type: "method", op: "eq", value: "POST" }] }]);
    expect(rule.action.mitigate.action).toBe("rate_limit");
    expect(rule.action.mitigate.rateLimit).toEqual({ algo: "fixed_window", window: 600, limit: 5, keys: ["ip"], action: "rate_limit" });
    // the per-IP limit in each instance's memory is 5 drops per 10 minutes: the firewall holds all instances to it
    expect(rule.action.mitigate.rateLimit.limit).toBe(DEFAULT_LIMITS.perIpDrops[0]!.max);
    expect(rule.action.mitigate.rateLimit.window).toBe(DEFAULT_LIMITS.perIpDrops[0]!.windowSec);
    expect(limits.postsPerIp).toMatch(/^5 POST requests per 10 minutes per IP, at Vercel's firewall \(fixed window, counted per region\)$/);
    expect(page).toContain("5 POST requests per 10 minutes from one IP, at Vercel's firewall (counted per region)");
    expect(readme).toContain("| POST requests per IP | 5 per 10 minutes, fixed window | Vercel's firewall (`vercel-firewall.json`), counted per region");
  });

  it("the gas cap, the day's share, the day's cap, the reserve and the web origins are the config's", () => {
    const l = DEFAULT_LIMITS;
    expect([l.maxDropGas, l.dailySpendPercent, l.dailyDrops, l.minBalanceWei]).toEqual([250_000n, 25, 150, 10n ** 17n]);
    expect(limits.maxDropGas).toBe(250_000);
    expect(limits.dropsPerDay).toMatch(/^at most 150, and no more than 25% of the wallet pays for at the most a drop can cost/);
    expect(limits.gasReserveMON).toMatch(/^0\.1: no drop is signed whose own cost/);
    expect(limits.browserOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(readme).toContain("| Gas per drop | at most 250,000 |");
    expect(readme).toContain("| Drops per day (UTC) | at most 150, and no more than 25% of the wallet pays for at the most a drop can cost |");
    expect(page).toContain("at most 150 drops, and no more than a quarter of the wallet pays for at the most a drop can\n        cost (250,000 gas at the price drops pay)");
  });

  it("the README calls no drop the most one can cost when another costs more, and every measured drop fits the gas cap", () => {
    // it called 248,600 gas (the largest note) "the most one note can cost" while a task's answer took 384,237
    expect(readme).not.toMatch(/the most one (note|drop) can cost/);
    const gasOf = (row: string) => Number(new RegExp(`${row} \\| [\\d,]+ bytes \\| ([\\d,]+) \\|`).exec(readme)![1]!.replace(/,/g, ""));
    const note = gasOf("the largest note");
    const answer = gasOf("the largest answer");
    expect([note, answer]).toEqual([248_600, 72_646]);
    expect(Math.max(note, answer)).toBeLessThanOrEqual(Number(DEFAULT_LIMITS.maxDropGas));
  });

  it("the answer's quote is described as the code bounds it: 80 characters, and the SHA-256 of the whole task", () => {
    expect(QUOTE_CHARS).toBe(80);
    expect(readme).toContain("quotes the task's first 80 characters");
    expect(card.skills.find((s) => s.id === "answer-a-sealed-task")!.description).toContain("quoting the task's first 80 characters with the SHA-256 of all of it");
    expect(page).toContain("quoting the task's first 80 characters with the SHA-256 of all of it");
  });

  it("docs/SPEC.md §2 makes this agent's key normative: the seed-based PRF, and that no passkey re-derives it", () => {
    const s2 = spec.slice(spec.indexOf("## 2. Derivation"), spec.indexOf("## 3. Envelope"));
    // the construction src/agent-key.ts implements (test/agent-key.test.ts recomputes it with OpenSSL)
    expect(s2).toContain('prf = HMAC-SHA256(seed, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ agentSalt(id, epoch)))');
    expect(s2).toContain("with the same salts and labels");
    expect(s2).toMatch(/recovered only from the seed: no passkey can re-derive it, the owner's included/);
    expect(s2).toContain("The reference agent (`examples/agent-memory`,\nERC-8004 agent #10260 from epoch 2 on) derives its keys this way.");
    // §2 said an agent key always comes from the owner's passkey, which re-derives it on any device
    expect(s2).not.toMatch(/comes from its owner's passkey with the agent id/);
    expect(s2).not.toMatch(/and the owner's passkey re-derives it/);
  });
});
