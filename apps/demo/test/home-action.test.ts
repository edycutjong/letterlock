// Which actions the home page offers (lib/home-action.ts, rendered by app/AddressDesk.tsx). "Seal a note to yourself" and
// "Open your inbox" follow only from a key the register holds. After an RPC outage during a create, the register
// cannot be read, and the page must offer "Post my key" (the step still needed) and "Read the register again", not the
// actions of a posted key, which lead to NO_KEY_PUBLISHED on /seal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { homeAction, type HomeState } from "../lib/home-action.ts";

const stored: HomeState = { host: "ok", stored: "stored", address: true, register: "found" };

test("seal and open are offered only for a key the register holds", () => {
  assert.equal(homeAction(stored), "found");
  for (const register of ["failed", "loading", "idle", "none"] as const) assert.notEqual(homeAction({ ...stored, register }), "found", register);
});

test("a register that could not be read offers the post and a second read; one being read offers its status only", () => {
  assert.equal(homeAction({ ...stored, register: "failed" }), "unknown");
  assert.equal(homeAction({ ...stored, register: "loading" }), "reading");
  assert.equal(homeAction({ ...stored, register: "idle" }), "reading");
  assert.equal(homeAction({ ...stored, register: "none" }), "post");
  assert.equal(homeAction({ ...stored, address: false, register: "idle" }), "post", "a passkey whose account is not known yet");
});

test("before the device is read, off the passkey host, with nothing stored, and while a flow runs", () => {
  assert.equal(homeAction({ ...stored, host: "pending" }), "wait");
  assert.equal(homeAction({ ...stored, stored: "pending" }), "wait");
  assert.equal(homeAction({ ...stored, host: "elsewhere" }), "elsewhere");
  assert.equal(homeAction({ host: "ok", stored: "none", address: false, register: "idle" }), "create");
  assert.equal(homeAction({ ...stored, register: "failed", running: "post" }), "running");
  assert.equal(homeAction({ ...stored, running: "rotate" }), "found", "a rotation runs from the card: the actions stay");
});

test("the home page renders from homeAction, and its failed state carries both ways on", () => {
  const desk = readFileSync(new URL("../app/AddressDesk.tsx", import.meta.url), "utf8");
  assert.match(desk, /homeAction\(\{/);
  const unknown = /case "unknown":([\s\S]*?)break;/.exec(desk)?.[1] ?? "";
  assert.match(unknown, /Post my key/);
  assert.match(unknown, /Read the register again/);
  assert.doesNotMatch(unknown, /Seal a note to yourself|Open your inbox/);
  const reading = /case "reading":([\s\S]*?)break;/.exec(desk)?.[1] ?? "";
  assert.doesNotMatch(reading, /<(Passkey)?Button|ButtonLink/);
});
