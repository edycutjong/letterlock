// /seal's To field: a whole address or agent is looked up; anything else that was typed gets an error naming both
// forms, where before the Seal button only stayed disabled without a word (a truncated paste such as 0x1234).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RECIPIENT_FORMS, recipientError } from "../lib/recipient.ts";

test("a whole address or agent id has no error, and neither has an empty field", () => {
  for (const ok of ["", "   ", "0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3", " 0xfa72da61400f345d85bf3d0d55395bdbebdb02b3 ", "agent:10260", "agent:0"])
    assert.equal(recipientError(ok), undefined, JSON.stringify(ok));
});

test("anything else typed gets the error naming both forms", () => {
  for (const bad of ["0x1234", "0xFa72dA61400f345d85BF3d0d55395bDbebDB02b", "0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3a", "0XFa72dA61400f345d85BF3d0d55395bDbebDB02b3", "agent:", "agent:01", "agent:-1", "agent:10260x", "alice.eth", "10260"])
    assert.equal(recipientError(bad), RECIPIENT_FORMS, JSON.stringify(bad));
  assert.match(RECIPIENT_FORMS, /0x and 40 hex digits/);
  assert.match(RECIPIENT_FORMS, /agent:10260/);
});
