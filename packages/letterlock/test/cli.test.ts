// The `letterlock` CLI, run in-process (run(argv, io)) against the anvil directory. test/pack.test.ts runs the
// built bin as a child process.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/cli/program.ts";
import { VERSION, decodeEnvelope, deriveKeyPair, fingerprint, open, toHex } from "../src/index.ts";
import { client, ctx, fund, fundedAccount, noChain } from "./anvil/context.ts";

type Result = { code: number; stdout: string; stderr: string };
const cli = async (argv: string[], o: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> => {
  let stdout = "", stderr = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    readStdin: async () => new TextEncoder().encode(o.stdin ?? ""),
    env: o.env ?? {},
  });
  return { code, stdout, stderr };
};
const chain = () => (ctx.ok ? ["--rpc", ctx.rpcUrl, "--directory", ctx.directory] : []);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("letterlock CLI without a chain", () => {
  it("--version prints the package version", async () => {
    expect(await cli(["--version"])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("--help lists the commands", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    for (const c of ["resolve", "seal", "verify", "inbox", "drop"]) expect(r.stdout).toContain(c);
  });

  it("a usage error exits 2; an unknown command too", async () => {
    expect((await cli(["resolve"])).code).toBe(2);
    expect((await cli(["publish"])).code).toBe(2);
    expect((await cli(["inbox", "0x0000000000000000000000000000000000000001", "--from-block", "-5"])).code).toBe(2);
  });

  it("a private key typed on the command line is refused and never echoed", async () => {
    const key = generatePrivateKey();
    for (const argv of [
      ["drop", "env.json", "--private-key", key],
      ["drop", "env.json", `--private-key=${key}`],
      ["drop", "env.json", "--private-key-env", key],
      ["resolve", key],
    ]) {
      const r = await cli(argv);
      expect(r.code, argv.join(" ")).not.toBe(0);
      expect(r.stdout + r.stderr).not.toContain(key.slice(2));
    }
    expect((await cli(["drop", "env.json", "--private-key-env", key])).stderr).toContain("NAME of an environment variable");
  });

  it("drop needs --private-key-env naming a variable that is set and holds a key", async () => {
    expect((await cli(["drop", "-"], { stdin: "{}" })).code).toBe(2);
    const unset = await cli(["drop", "-", "--private-key-env", "LETTERLOCK_TEST_KEY"], { stdin: "{}" });
    expect(unset.code).toBe(1);
  });
});

describe.skipIf(noChain)("letterlock CLI on the anvil directory", () => {
  let recipient: string;
  const keys = deriveKeyPair(new Uint8Array(32).fill(91), 1);
  let dir: string;

  beforeAll(async () => {
    if (!ctx.ok) return;
    const account = await fundedAccount();
    recipient = account.address;
    await client().publish({ account, keys });
    dir = await mkdtemp(join(tmpdir(), "letterlock-cli-"));
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("resolve prints the key, and --json the same values as the SDK", async () => {
    const r = await cli(["resolve", recipient, ...chain()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`key        0x${toHex(keys.publicKey)}`);
    expect(r.stdout).toContain(`kid        ${fingerprint(keys.publicKey)}`);
    const j = JSON.parse((await cli(["resolve", recipient, "--json", ...chain()])).stdout) as Record<string, unknown>;
    const k = await client().resolve(recipient);
    expect(j).toEqual({ recipient: k.recipient, chainId: 143, directory: k.directory, epoch: 1, publicKey: `0x${toHex(keys.publicKey)}`, kid: k.kid, updatedAt: k.updatedAt });
  });

  it("resolve of an address without a key exits 1 with NO_KEY_PUBLISHED", async () => {
    const r = await cli(["resolve", privateKeyToAccount(generatePrivateKey()).address, ...chain()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^letterlock: NO_KEY_PUBLISHED: /);
  });

  it("--testnet against a chain-143 RPC exits 1 (INPUT_INVALID): the chain is checked", async () => {
    const r = await cli(["resolve", recipient, "--testnet", ...chain()]);
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining("INPUT_INVALID")]);
    // the built-in testnet directory has no code here: the message still names the chain, not a missing directory
    const builtIn = await cli(["resolve", recipient, "--testnet", "--rpc", ctx.ok ? ctx.rpcUrl : ""]);
    expect([builtIn.code, builtIn.stderr]).toEqual([1, expect.stringContaining("the RPC serves chain 143, not Monad testnet (10143)")]);
  });

  it("seal <file> --out writes a new envelope file that the recipient's key opens, and never overwrites", async () => {
    const note = join(dir, "note.txt");
    await writeFile(note, "meet at the north gate");
    const out = join(dir, "env.json");
    const r = await cli(["seal", recipient, note, "--out", out, ...chain()]);
    expect([r.code, r.stdout]).toEqual([0, ""]);
    expect(r.stderr).toContain(`sealed 22 bytes to ${recipient.toLowerCase()}`);
    const env = decodeEnvelope(await readFile(out, "utf8"));
    expect(text(await open(env, keys))).toBe("meet at the north gate");
    expect((await cli(["seal", recipient, note, "--out", out, ...chain()])).code).toBe(1);
  });

  it("seal - reads standard input and prints the envelope", async () => {
    const r = await cli(["seal", recipient, "-", ...chain()], { stdin: "from stdin" });
    expect(r.code).toBe(0);
    expect(text(await open(decodeEnvelope(r.stdout), keys))).toBe("from stdin");
  });

  it("verify seals a random nonce to the printed key; only the key's holder reads it back", async () => {
    const r = await cli(["verify", recipient, "--json", ...chain()]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { nonce: string; envelope: unknown; key: { kid: string } };
    expect(j.nonce).toMatch(/^[0-9a-f]{32}$/);
    const env = decodeEnvelope(JSON.stringify(j.envelope));
    expect(env.kid).toBe(j.key.kid);
    expect(text(await open(env, keys))).toBe(j.nonce);
    const human = await cli(["verify", recipient, ...chain()]);
    expect(human.stdout).toContain("nonce");
    expect(human.stdout).toContain(fingerprint(keys.publicKey));
  });

  it("drop sends an envelope with a key from the environment; inbox lists it", async () => {
    if (!ctx.ok) return;
    const senderKey = generatePrivateKey();
    const sender = privateKeyToAccount(senderKey);
    await fund(sender.address, "1");
    const envFile = join(dir, "drop.json");
    expect((await cli(["seal", recipient, "-", "--out", envFile, ...chain()], { stdin: "dropped by the CLI" })).code).toBe(0);
    const r = await cli(["drop", envFile, "--private-key-env", "LETTERLOCK_SENDER_KEY", ...chain()], { env: { LETTERLOCK_SENDER_KEY: senderKey } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`from       ${sender.address}`);
    expect(r.stdout + r.stderr).not.toContain(senderKey.slice(2));
    const tx = /tx +(0x[0-9a-f]{64})/.exec(r.stdout)?.[1];
    const block = /block +(\d+)/.exec(r.stdout)?.[1];
    const inbox = await cli(["inbox", recipient, "--from-block", block!, "--json", ...chain()]);
    const j = JSON.parse(inbox.stdout) as { envelopes: { transactionHash: string; envelope: unknown }[] };
    expect(j.envelopes.map((e) => e.transactionHash)).toEqual([tx]);
    expect(text(await open(decodeEnvelope(JSON.stringify(j.envelopes[0]!.envelope)), keys))).toBe("dropped by the CLI");
    const human = await cli(["inbox", recipient, "--from-block", block!, ...chain()]);
    expect(human.stdout).toMatch(/^1 envelope for 0x[0-9a-f]{40} on Monad mainnet \(143\), blocks \d+\.\.\d+ \(1 eth_getLogs request, up to 10000 blocks each\)/);
  });

  it("inbox against an address that holds no directory exits 1 instead of printing '0 envelopes'; a bad checksum too", async () => {
    const nowhere = privateKeyToAccount(generatePrivateKey()).address;
    const rpc = ["--rpc", ctx.ok ? ctx.rpcUrl : ""];
    const r = await cli(["inbox", recipient, "--from-block", "1", "--directory", nowhere, ...rpc]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", expect.stringContaining(`INPUT_INVALID: ${nowhere} is not a Letterlock directory`)]);
    const typo = await cli(["inbox", recipient, "--from-block", "1", "--directory", "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7F", ...rpc]);
    expect([typo.code, typo.stderr]).toEqual([1, expect.stringContaining("EIP-55 checksum")]);
  });

  it("drop refuses an envelope for another chain before sending", async () => {
    const envFile = join(dir, "other-chain.json");
    await writeFile(envFile, (await cli(["seal", recipient, "-", ...chain()], { stdin: "x" })).stdout.replace('"chainId": 143', '"chainId": 10143'));
    const r = await cli(["drop", envFile, "--private-key-env", "K", ...chain()], { env: { K: generatePrivateKey() } });
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining("INPUT_INVALID")]);
  });
});
