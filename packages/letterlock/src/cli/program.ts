import { Command, CommanderError, InvalidArgumentError } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "../bytes.ts";
import { letterlock, type LetterlockClient, type ResolvedKey } from "../client.ts";
import { DEPLOYMENTS, type LetterlockChain } from "../deployments.ts";
import { decodeEnvelope, encodeEnvelope, seal, type Envelope } from "../envelope.ts";
import { LetterlockError, isLetterlockError } from "../errors.ts";
import { VERSION } from "../version.ts";

export type CliIo = {
  readonly stdout: { write(s: string): unknown };
  readonly stderr: { write(s: string): unknown };
  /** All of standard input, for the `-` file argument. */
  readonly readStdin: () => Promise<Uint8Array>;
  readonly env: Readonly<Record<string, string | undefined>>;
};

type ChainOptions = { testnet?: boolean; rpc?: string; directory?: string };

/** 64 hex digits: a private key someone typed where an option value was expected. Never echoed back. */
const redact = (s: string) => s.replace(/(0x)?[0-9a-fA-F]{64}/g, "[redacted]");

const json = (v: unknown) =>
  `${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? bytesToHex(x) : x), 2)}\n`;

const chainOf = (o: ChainOptions): LetterlockChain => (o.testnet ? "monad-testnet" : "monad");

const clientFor = (o: ChainOptions): LetterlockClient =>
  letterlock({
    chain: chainOf(o),
    ...(o.rpc ? { rpcUrl: o.rpc } : {}),
    ...(o.directory ? { directory: o.directory as `0x${string}` } : {}),
  });

const where = (ll: LetterlockClient) => `${DEPLOYMENTS[ll.chain].network} (${ll.chainId})`;

const keyJson = (k: ResolvedKey) => ({
  recipient: k.recipient,
  chainId: k.chainId,
  directory: k.directory,
  epoch: k.epoch,
  publicKey: bytesToHex(k.publicKey),
  kid: k.kid,
  updatedAt: k.updatedAt,
});

const keyText = (k: ResolvedKey, ll: LetterlockClient) =>
  [
    `${k.recipient} has a key on ${where(ll)}`,
    `  key        0x${toHex(k.publicKey)}`,
    `  kid        ${k.kid}`,
    `  epoch      ${k.epoch}`,
    `  published  ${new Date(k.updatedAt * 1000).toISOString()} (block time)`,
    `  directory  ${k.directory}`,
    "",
  ].join("\n");

const blockNumber = (v: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(v)) throw new InvalidArgumentError("expected a block number");
  return BigInt(v);
};

const readInput = async (file: string, io: CliIo): Promise<Uint8Array> => {
  if (file === "-") return io.readStdin();
  try { return new Uint8Array(await readFile(file)); }
  catch (cause) { throw new LetterlockError("INPUT_INVALID", `cannot read ${file}`, { cause }); }
};

/** Never overwrites: an envelope file that exists stays as it is. */
const writeNew = async (file: string, text: string) => {
  try { await writeFile(file, text, { flag: "wx" }); }
  catch (cause) { throw new LetterlockError("INPUT_INVALID", `cannot write ${file} (it may already exist)`, { cause }); }
};

/** The drop key comes only from an environment variable named on the command line, never from the line itself. */
const accountFromEnv = (name: string, io: CliIo) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
    throw new LetterlockError("INPUT_INVALID", "--private-key-env takes the NAME of an environment variable that holds the key, not a key");
  const value = io.env[name]?.trim();
  if (!value) throw new LetterlockError("INPUT_INVALID", `environment variable ${name} is not set`);
  const key = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new LetterlockError("INPUT_INVALID", `environment variable ${name} does not hold a 32-byte hex private key`);
  try { return privateKeyToAccount(key); }
  catch { throw new LetterlockError("INPUT_INVALID", `environment variable ${name} does not hold a valid secp256k1 private key`); }
};

export const buildProgram = (io: CliIo): Command => {
  const out = (s: string) => void io.stdout.write(s);
  const note = (s: string) => void io.stderr.write(s);
  const withChain = (cmd: Command) =>
    cmd
      .option("--testnet", "use Monad testnet (chain 10143) instead of Monad mainnet (143)")
      .option("--rpc <url>", "JSON-RPC endpoint (default: the chain's public RPC)")
      .option("--directory <address>", "Letterlock directory (default: the deployment on the chain)");

  const program = new Command()
    .name("letterlock")
    .description("Seal data to a passkey's encryption address on Monad. No key material is read or written, except a drop's signing key from an environment variable.")
    .version(VERSION, "-v, --version")
    .exitOverride()
    .configureOutput({ writeOut: (s) => out(s), writeErr: (s) => note(redact(s)) });

  withChain(program.command("resolve"))
    .description("print the key a recipient has published: one keyOf / keyOfAgent read")
    .argument("<to>", "0x address or agent:<id>")
    .option("--json", "print JSON")
    .action(async (to: string, o: ChainOptions & { json?: boolean }) => {
      const ll = clientFor(o);
      const key = await ll.resolve(to);
      out(o.json ? json(keyJson(key)) : keyText(key, ll));
    });

  withChain(program.command("seal"))
    .description("seal a file (or - for standard input) to a recipient's key; prints the envelope JSON")
    .argument("<to>", "0x address or agent:<id>")
    .argument("<file>", "file to seal, or - for standard input")
    .option("--out <file>", "write the envelope to a new file instead of standard output")
    .action(async (to: string, file: string, o: ChainOptions & { out?: string }) => {
      const ll = clientFor(o);
      const plaintext = await readInput(file, io);
      const envelope = await ll.sealTo(to, plaintext);
      const size = encodeEnvelope(envelope).length;
      if (o.out) await writeNew(o.out, json(envelope)); else out(json(envelope));
      note(`sealed ${plaintext.length} bytes to ${envelope.recipient} (epoch ${envelope.epoch}, kid ${envelope.kid}) on ${where(ll)}: a ${size}-byte envelope${o.out ? ` in ${o.out}` : ""}\n`);
    });

  withChain(program.command("verify"))
    .description("resolve a recipient and seal a random nonce to its key: whoever opens the envelope and reads the nonce back holds the passkey")
    .argument("<to>", "0x address or agent:<id>")
    .option("--out <file>", "write the envelope to a new file (share only this file with the recipient)")
    .option("--json", "print JSON")
    .action(async (to: string, o: ChainOptions & { out?: string; json?: boolean }) => {
      const ll = clientFor(o);
      const key = await ll.resolve(to);
      const nonce = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      // sealed to the key printed above, from the same read
      const envelope = await seal({ chainId: ll.chainId, directory: ll.directory, to: key, plaintext: new TextEncoder().encode(nonce) });
      if (o.out) await writeNew(o.out, json(envelope));
      if (o.json) { out(json({ key: keyJson(key), nonce, ...(o.out ? { envelopeFile: o.out } : { envelope }) })); return; }
      out(keyText(key, ll));
      out(`\nSealed a random nonce to this key. Only the passkey behind it can open the envelope${o.out ? ` in ${o.out}` : " below"}:\n`);
      out(`ask its owner to open it and read the nonce back.\n  nonce      ${nonce}\n  kid        ${envelope.kid} (the key the envelope is sealed to)\n`);
      if (!o.out) out(`\n${json(envelope)}`);
    });

  withChain(program.command("inbox"))
    .description("list the envelopes dropped for a recipient (Dropped logs of the directory)")
    .argument("<to>", "0x address or agent:<id>")
    .option("--from-block <n>", "first block to scan (default: the directory's deploy block)", blockNumber)
    .option("--to-block <n>", "last block to scan (default: the chain head)", blockNumber)
    .option("--json", "print JSON, envelopes included")
    .action(async (to: string, o: ChainOptions & { fromBlock?: bigint; toBlock?: bigint; json?: boolean }) => {
      const ll = clientFor(o);
      const r = await ll.inbox(to, {
        ...(o.fromBlock !== undefined ? { fromBlock: o.fromBlock } : {}),
        ...(o.toBlock !== undefined ? { toBlock: o.toBlock } : {}),
      });
      if (o.json) { out(json(r)); return; }
      const n = r.envelopes.length;
      out(`${n} envelope${n === 1 ? "" : "s"} for ${r.recipient} on ${where(ll)}, blocks ${r.fromBlock}..${r.toBlock} (${r.requests} eth_getLogs request${r.requests === 1 ? "" : "s"}, up to ${r.blockRange} blocks each)\n`);
      for (const e of r.envelopes)
        out(`  block ${e.blockNumber}  tx ${e.transactionHash}  epoch ${e.envelope.epoch}  kid ${e.envelope.kid}  ${e.bytes} bytes\n`);
      if (r.rejected.length) {
        out(`${r.rejected.length} drop${r.rejected.length === 1 ? "" : "s"} for ${r.recipient} that are not envelopes for it:\n`);
        for (const x of r.rejected) out(`  block ${x.blockNumber}  tx ${x.transactionHash}  ${x.bytes} bytes: ${x.reason}\n`);
      }
    });

  withChain(program.command("drop"))
    .description("send an envelope to its recipient on the directory (a transaction: it costs gas)")
    .argument("<envelope>", "envelope JSON file, or - for standard input")
    .requiredOption("--private-key-env <VAR>", "NAME of the environment variable holding the sender's private key (the key itself is never an argument)")
    .action(async (file: string, o: ChainOptions & { privateKeyEnv: string }) => {
      const account = accountFromEnv(o.privateKeyEnv, io);
      const ll = clientFor(o);
      const envelope: Envelope = decodeEnvelope(await readInput(file, io));
      const r = await ll.drop({ account, envelope });
      const explorer = o.directory || o.rpc ? undefined : DEPLOYMENTS[ll.chain].explorer;
      out([
        `dropped a ${r.bytes}-byte envelope for ${r.recipient} on ${where(ll)}`,
        `  from       ${account.address}`,
        `  tx         ${r.transactionHash}`,
        `  block      ${r.blockNumber}`,
        `  gas        ${r.gasUsed}`,
        ...(explorer ? [`  explorer   ${explorer}/tx/${r.transactionHash}`] : []),
        "",
      ].join("\n"));
    });

  return program;
};

/** Runs the CLI; resolves to the exit code (0 ok, 1 an error the message names, 2 a usage error). */
export const run = async (argv: readonly string[], io: CliIo): Promise<number> => {
  try {
    await buildProgram(io).parseAsync([...argv], { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    io.stderr.write(redact(`letterlock: ${isLetterlockError(e) ? e.message : e instanceof Error ? e.message : String(e)}\n`));
    return 1;
  }
};
