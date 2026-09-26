import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.ts";

// package.json maps only "." to src/index.ts, so anything an app imports from "letterlock" must be re-exported here.
describe("package entry", () => {
  it("exports the contract ABI for viem", () => {
    const names = sdk.letterlockAbi.filter((e) => e.type === "function").map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["keyOf", "keyOfAgent", "publish", "publishForAgent", "drop"]));
  });
});
