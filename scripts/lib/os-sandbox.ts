// The OS-level half of the offline proof: run a command with its network taken away by the operating system, so no
// code in it (JavaScript, a native addon, a child process it starts) can reach another host, whatever it calls.
//
//   macOS  sandbox-exec -p '(version 1)(allow default)(deny network*)': every socket operation is denied, the
//          connection to the system resolver (mDNSResponder) included, so a name lookup fails too. A profile that
//          denies only "network-outbound (remote ip)" leaves that resolver socket open: names still resolve.
//   Linux  unshare --user --map-root-user --net: a new network namespace, where no interface is up (not even
//          loopback). Ubuntu 24.04 lets an unprivileged user make one only with
//          kernel.apparmor_restrict_unprivileged_userns=0 (.github/workflows/ci.yml sets it).
//
// scripts/verify_offline.ts re-runs itself under networkSandbox() when one is available, and checks from inside that a
// TCP connection, a UDP datagram and a name lookup all fail before it trusts it (osNetworkCheck). Where none is
// available it says so; LETTERLOCK_REQUIRE_NETWORK_SANDBOX=1 (CI) turns that into a failure.
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync } from "node:fs";
import net from "node:net";

/** Set in the environment of a process started under the sandbox: the tool's name. */
export const SANDBOX_ENV = "LETTERLOCK_NETWORK_SANDBOX";
/** "1": a missing sandbox is a failure, not a note. */
export const REQUIRE_SANDBOX_ENV = "LETTERLOCK_REQUIRE_NETWORK_SANDBOX";

export const MACOS_PROFILE = "(version 1)(allow default)(deny network*)";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const UNSHARE = ["--user", "--map-root-user", "--net"] as const;

export type Sandbox = {
  readonly tool: "sandbox-exec" | "unshare";
  /** What the sandbox denies, for the report. */
  readonly denies: string;
  /** The command line that runs argv inside the sandbox. */
  readonly wrap: (argv: readonly string[]) => string[];
};
export type NoSandbox = { readonly unavailable: string };

const firstLine = (s: string | Buffer | null | undefined) => String(s ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "";

/** The sandbox this machine offers, tried with a command that does nothing; or why there is none. */
export const networkSandbox = (): Sandbox | NoSandbox => {
  if (process.platform === "darwin") {
    if (!existsSync(SANDBOX_EXEC)) return { unavailable: `${SANDBOX_EXEC} is missing` };
    const r = spawnSync(SANDBOX_EXEC, ["-p", MACOS_PROFILE, "/usr/bin/true"], { encoding: "utf8" });
    if (r.status !== 0) return { unavailable: `sandbox-exec failed: ${firstLine(r.stderr) || r.error?.message || `exit ${r.status}`}` };
    return { tool: "sandbox-exec", denies: "every socket (deny network*)", wrap: (argv) => [SANDBOX_EXEC, "-p", MACOS_PROFILE, ...argv] };
  }
  if (process.platform === "linux") {
    const r = spawnSync("unshare", [...UNSHARE, "true"], { encoding: "utf8" });
    if (r.status !== 0) return { unavailable: `unshare ${UNSHARE.join(" ")} failed: ${firstLine(r.stderr) || r.error?.message || `exit ${r.status}`}` };
    return { tool: "unshare", denies: "every interface (a new network namespace)", wrap: (argv) => ["unshare", ...UNSHARE, ...argv] };
  }
  return { unavailable: `no network sandbox for ${process.platform}` };
};

export type OsNetworkCheck = {
  /** True when all three attempts failed: the process has no network. */
  readonly blocked: boolean;
  /** The error code each attempt ended with, or what it reached. */
  readonly tcp: string;
  readonly udp: string;
  readonly dns: string;
};

const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("no answer"), { code: "TIMEOUT" })), ms).unref())]);
const codeOf = (e: unknown) => String((e as { code?: unknown }).code ?? (e as Error).message ?? e);

/**
 * Tries the network three ways, with nothing in this process blocking it (run it BEFORE blockNetwork()): a TCP
 * connection to 1.1.1.1:443, a UDP datagram to 1.1.1.1:53 and a lookup of rpc.monad.xyz. Under a working sandbox all
 * three fail; a timeout counts as reaching nothing. Outside one, this touches the network: call it only under one.
 */
export const osNetworkCheck = async (timeoutMs = 3000): Promise<OsNetworkCheck> => {
  let tcp: string;
  try {
    await within(timeoutMs, new Promise<void>((resolve, reject) => {
      const s = net.connect(443, "1.1.1.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", reject);
    }));
    tcp = "connected";
  } catch (e) { tcp = codeOf(e); }
  let udp: string;
  try {
    await within(timeoutMs, new Promise<void>((resolve, reject) => {
      const s = dgram.createSocket("udp4");
      const done = (e?: Error | null) => { try { s.close(); } catch { /* closed */ } if (e) reject(e); else resolve(); };
      s.once("error", done);
      s.send(Buffer.from([0]), 53, "1.1.1.1", done);
    }));
    udp = "sent";
  } catch (e) { udp = codeOf(e); }
  let name: string;
  try {
    name = `resolved to ${(await within(timeoutMs, dns.promises.lookup("rpc.monad.xyz"))).address}`;
  } catch (e) { name = codeOf(e); }
  return { blocked: tcp !== "connected" && udp !== "sent" && !name.startsWith("resolved"), tcp, udp, dns: name };
};
