// How drops leave one instance: one at a time, and sent again only when the node says the nonce was taken.
import { LetterlockError } from "letterlock";
import { describe, expect, it } from "vitest";
import { oneAtATime } from "../src/chain.ts";

const deferred = () => {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("oneAtATime", () => {
  it("starts a call only when the previous one has settled", async () => {
    const events: string[] = [];
    const gates = [deferred(), deferred()];
    const send = oneAtATime(async (i: number) => {
      events.push(`start ${i}`);
      const v = await gates[i]!.promise;
      events.push(`end ${i}`);
      return v;
    });
    const a = send(0);
    const b = send(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["start 0"]);
    gates[1]!.resolve("b");
    gates[0]!.resolve("a");
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(events).toEqual(["start 0", "end 0", "start 1", "end 1"]);
  });

  it("sends again when another transaction took the nonce, also when the message is in the error's cause", async () => {
    for (const failure of [
      new Error("nonce too low: next nonce 5, tx nonce 4"),
      new LetterlockError("CHAIN_UNAVAILABLE", "drop 478 bytes to 0x…: failed", { cause: new Error("replacement transaction underpriced") }),
      new Error("Nonce has already been used"),
    ]) {
      let calls = 0;
      const send = oneAtATime(async () => {
        if (++calls === 1) throw failure;
        return "sent";
      });
      expect(await send()).toBe("sent");
      expect(calls, failure.message).toBe(2);
    }
  });

  it("sends at most three times, and never again for any other failure", async () => {
    let calls = 0;
    const stuck = oneAtATime(async () => { calls++; throw new Error("nonce too low"); });
    await expect(stuck()).rejects.toThrow(/nonce too low/);
    expect(calls).toBe(3);
    for (const message of ["already known", "insufficient funds for gas", "execution reverted: NoKeyPublished"]) {
      let n = 0;
      const send = oneAtATime(async () => { n++; throw new Error(message); });
      await expect(send()).rejects.toThrow(message);
      expect(n, message).toBe(1);
    }
  });

  it("a failed call does not hold up the calls queued behind it", async () => {
    const send = oneAtATime(async (fail: boolean) => {
      if (fail) throw new Error("reverted");
      return "ok";
    });
    const first = send(true);
    const second = send(false);
    await expect(first).rejects.toThrow("reverted");
    expect(await second).toBe("ok");
  });
});
