// The pages show EXAMPLE data (lib/examples.json). This keeps it honest: every key is the SDK's derivation over its
// labelled string, every envelope really opens to the text the page prints, the tampered copy really fails as
// TAMPERED, and every failure a slip quotes is what the SDK's open() really throws for those inputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fingerprint, isLetterlockError, open, toHex, type Envelope } from "letterlock";
import { TESTNET, exampleAddress, exampleKeys } from "../scripts/example-values.ts";

type Key = { epoch: number; publicKey: string; fingerprint: string };
const data = JSON.parse(readFileSync(new URL("../lib/examples.json", import.meta.url), "utf8")) as {
  directory: { chainId: number; directory: string };
  personas: { name: string; address: string; keys: Key[] }[];
  agents: { recipient: string; keys: Key[] }[];
  letters: { id: string; to: string; recipient: string; epoch: number; text: string; bytes: number; envelope: Envelope }[];
  tampered: { from: string; ctByte: number; envelope: Envelope };
  failures: { code: string; letter: string; key: { name: string; epoch: number }; values: Record<string, string | number> }[];
};

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

test("every example key is the SDK's derivation over its labelled string", () => {
  for (const p of data.personas) {
    assert.equal(p.address, exampleAddress(p.name.toLowerCase()));
    for (const k of p.keys) {
      const keys = exampleKeys(p.name.toLowerCase(), k.epoch);
      assert.equal(k.publicKey, `0x${toHex(keys.publicKey)}`, `${p.name} epoch ${k.epoch}`);
      assert.equal(k.fingerprint, fingerprint(keys.publicKey));
    }
  }
  for (const a of data.agents)
    for (const k of a.keys) assert.equal(k.publicKey, `0x${toHex(exampleKeys(`agent ${a.recipient.slice(6)}`, k.epoch).publicKey)}`);
});

test("Kai rotated: epoch 2 is a different key from epoch 1", () => {
  const kai = data.personas.find((p) => p.name === "Kai")!;
  assert.deepEqual(kai.keys.map((k) => k.epoch), [1, 2]);
  assert.notEqual(kai.keys[0]!.fingerprint, kai.keys[1]!.fingerprint);
});

test("every example envelope opens to the text the page prints, with its recipient's key for its epoch", async () => {
  for (const l of data.letters) {
    const p = data.personas.find((x) => x.name === l.to)!;
    assert.equal(l.envelope.recipient, p.address);
    assert.equal(l.envelope.chainId, TESTNET.chainId);
    assert.equal(l.envelope.directory, TESTNET.directory.toLowerCase());
    assert.equal(l.envelope.epoch, l.epoch);
    assert.equal(l.bytes, new TextEncoder().encode(JSON.stringify(l.envelope)).length);
    const pt = await open(l.envelope, exampleKeys(l.to.toLowerCase(), l.epoch));
    assert.equal(decode(pt), l.text, l.id);
  }
});

test("the tampered copy differs from its letter in one ciphertext byte and fails as TAMPERED", async () => {
  const original = data.letters.find((l) => l.id === data.tampered.from)!.envelope;
  const a = Buffer.from(original.ct, "base64url");
  const b = Buffer.from(data.tampered.envelope.ct, "base64url");
  assert.equal(a.length, b.length);
  const diff = [...a].flatMap((x, i) => (x === b[i] ? [] : [i]));
  assert.deepEqual(diff, [data.tampered.ctByte]);
  await assert.rejects(open(data.tampered.envelope, exampleKeys("maya", 1)), (e) => isLetterlockError(e, "TAMPERED"));
});

test("each failure a slip quotes is what open() throws, with the values it quotes", async () => {
  assert.deepEqual(data.failures.map((f) => f.code).sort(), ["EPOCH_MISMATCH", "TAMPERED", "WRONG_KEY"]);
  for (const f of data.failures) {
    const env = f.letter === "tampered" ? data.tampered.envelope : data.letters.find((l) => l.id === f.letter)!.envelope;
    const keys = exampleKeys(f.key.name.toLowerCase(), f.key.epoch);
    await assert.rejects(open(env, keys), (e) => isLetterlockError(e, f.code as never), f.code);
    if (f.code === "WRONG_KEY") assert.deepEqual(f.values, { sealedTo: env.kid, derived: fingerprint(keys.publicKey) });
    if (f.code === "EPOCH_MISMATCH") assert.deepEqual(f.values, { envelopeEpoch: env.epoch, keyEpoch: keys.epoch });
  }
});

test("no example value is dressed as a transaction: the data holds no tx hashes", () => {
  const json = readFileSync(new URL("../lib/examples.json", import.meta.url), "utf8");
  assert.doesNotMatch(json, /"(postedTx|droppedTx|txHash|tx)"/);
});
