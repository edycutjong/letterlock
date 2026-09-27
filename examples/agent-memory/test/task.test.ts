import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TaskError, buildReply, encodeReply, encodeTask, newNonce, parseReply, parseTask } from "../src/task.ts";

const now = 1_790_480_000;
const limits = { nowSec: now, maxAgeSec: 600, maxSkewSec: 60, textMaxChars: 1000 };
const utf8 = (s: string) => new TextEncoder().encode(s);
const good = { replyTo: "0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3", nonce: "0123456789abcdef0123456789abcdef", issuedAt: now - 5, text: "summarize the lease" } as const;
const raw = (o: Record<string, unknown>) => utf8(JSON.stringify({ v: 1, ...good, ...o }));
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof TaskError ? e.code : `not a TaskError: ${String(e)}`; }
  return "no error";
};

describe("parseTask", () => {
  it("takes a task and lower-cases its reply address", () => {
    expect(parseTask(encodeTask(good), limits)).toEqual({ v: 1, ...good, replyTo: good.replyTo.toLowerCase() });
    expect(parseTask(raw({ replyTo: "agent:4412" }), limits).replyTo).toBe("agent:4412");
  });

  it("refuses what is not a task object", () => {
    expect(code(() => parseTask(utf8("not json"), limits))).toBe("TASK_INVALID");
    expect(code(() => parseTask(new Uint8Array([0xff, 0xfe]), limits))).toBe("TASK_INVALID");
    expect(code(() => parseTask(utf8("[1]"), limits))).toBe("TASK_INVALID");
    expect(code(() => parseTask(raw({ v: 2 }), limits))).toBe("TASK_INVALID");
  });

  it("refuses a missing or malformed reply address, nonce or time", () => {
    for (const bad of [{ replyTo: undefined }, { replyTo: 7 }, { replyTo: "0x1234" }, { replyTo: "agent:-1" }])
      expect(code(() => parseTask(raw(bad), limits)), JSON.stringify(bad)).toBe("TASK_INVALID");
    for (const bad of [{ nonce: undefined }, { nonce: "0123456789ABCDEF0123456789ABCDEF" }, { nonce: "0123" }, { nonce: 5 }])
      expect(code(() => parseTask(raw(bad), limits)), JSON.stringify(bad)).toBe("TASK_INVALID");
    for (const bad of [{ issuedAt: "now" }, { issuedAt: 1.5 }, { issuedAt: undefined }])
      expect(code(() => parseTask(raw(bad), limits)), JSON.stringify(bad)).toBe("TASK_INVALID");
  });

  it("takes tasks sealed in the last 600 s (60 s of clock skew ahead), and calls older or later ones stale", () => {
    expect(parseTask(raw({ issuedAt: now - 600 }), limits).issuedAt).toBe(now - 600);
    expect(parseTask(raw({ issuedAt: now + 60 }), limits).issuedAt).toBe(now + 60);
    expect(code(() => parseTask(raw({ issuedAt: now - 601 }), limits))).toBe("TASK_STALE");
    expect(code(() => parseTask(raw({ issuedAt: now + 61 }), limits))).toBe("TASK_STALE");
  });

  it("takes up to 1000 characters of well-formed, non-blank text", () => {
    expect(parseTask(raw({ text: "🔒".repeat(1000) }), limits).text).toBe("🔒".repeat(1000));
    expect(code(() => parseTask(raw({ text: "a".repeat(1001) }), limits))).toBe("TASK_TOO_LONG");
    expect(code(() => parseTask(raw({ text: "  \n" }), limits))).toBe("TASK_INVALID");
    expect(code(() => parseTask(raw({ text: 42 }), limits))).toBe("TASK_INVALID");
    // JSON can carry a lone surrogate; it is not text anyone wrote
    expect(code(() => parseTask(utf8(`{"v":1,"replyTo":"${good.replyTo}","nonce":"${good.nonce}","issuedAt":${now},"text":"\\ud800"}`), limits))).toBe("TASK_INVALID");
  });

  it("newNonce gives 32 lower-case hex digits, different each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe("buildReply", () => {
  it("quotes the task in full, with its SHA-256, the nonce it answers and the key it was sealed to", () => {
    const task = parseTask(encodeTask(good), limits);
    const reply = buildReply({ agent: "agent:10260", task, sealedTo: { recipient: "agent:10260", epoch: 2, kid: "0011223344556677" }, openedAt: now });
    expect(reply).toMatchObject({
      v: 1,
      from: "agent:10260",
      inReplyTo: good.nonce,
      openedAt: now,
      task: { sha256: createHash("sha256").update(good.text).digest("hex"), chars: good.text.length, sealedTo: { recipient: "agent:10260", epoch: 2, kid: "0011223344556677" } },
    });
    expect(reply.text).toContain(`“${good.text}”`);
    expect(reply.text).toContain("I cannot open it either");
    expect(parseReply(encodeReply(reply))).toEqual(reply);
  });
});
