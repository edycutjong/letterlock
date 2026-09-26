import type { Metadata } from "next";
import { ExampleBadge } from "@/components/ExampleBadge";
import { ExampleAction } from "@/components/ExampleAction";
import { ExampleForm } from "@/components/ExampleForm";
import { TextField } from "@/components/Field";
import { ArrowOutIcon, LookupIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { RegisterTable, type RegisterRow } from "@/components/RegisterTable";
import { DIRECTORY, TESTNET_TEST_KEY } from "@/lib/deployment.ts";
import { EXAMPLE_AGENTS, persona } from "@/lib/examples.ts";
import { shortHex } from "@/lib/format.ts";
import styles from "./register.module.css";

export const metadata: Metadata = { title: "The register" };

const example = (id: string, addressee: string, epoch: number, fingerprint: string, state?: RegisterRow["state"]): RegisterRow => ({
  id,
  addressee,
  epoch,
  fingerprint,
  posted: { kind: "example" },
  state,
});

export default function Register() {
  const maya = persona("Maya");
  const nadia = persona("Nadia");
  const kai = persona("Kai");
  const agent = EXAMPLE_AGENTS[0]!;
  const liveRows: RegisterRow[] = [
    {
      id: "testnet-test-key",
      addressee: TESTNET_TEST_KEY.address,
      epoch: TESTNET_TEST_KEY.epoch,
      fingerprint: TESTNET_TEST_KEY.fingerprint,
      posted: {
        kind: "tx",
        hash: TESTNET_TEST_KEY.txHash,
        href: TESTNET_TEST_KEY.txUrl,
        block: TESTNET_TEST_KEY.block,
        at: TESTNET_TEST_KEY.updatedAt,
        network: "Testnet",
      },
      note: "Test key from the deploy smoke test: random bytes stood in for a passkey",
    },
  ];
  // newest first; Kai rotated, so his epoch-1 line stays in the register, ruled through
  const exampleRows: RegisterRow[] = [
    example("agent", agent.recipient, agent.keys[0]!.epoch, agent.keys[0]!.fingerprint),
    example("kai-2", kai.address, kai.keys[1]!.epoch, kai.keys[1]!.fingerprint),
    example("maya", maya.address, maya.keys[0]!.epoch, maya.keys[0]!.fingerprint, "found"),
    example("nadia", nadia.address, nadia.keys[0]!.epoch, nadia.keys[0]!.fingerprint),
    example("kai-1", kai.address, kai.keys[0]!.epoch, kai.keys[0]!.fingerprint, "superseded"),
  ];
  return (
    <main id="main" className="page">
      <PageHead
        title="The register"
        lede="Every key posted to the directory. Anyone may read it: find an address, then seal to the key on its line. When someone rotates, their earlier line stays in the register, ruled through."
      />

      <ExampleForm className={styles.lookup} role="search" aria-label="Look up an address">
        <TextField
          className={styles.lookupField}
          label="Look up"
          name="q"
          data
          placeholder="0x… or agent:<id>"
          hint="keyOf(address) or keyOfAgent(id), read from the directory. Free: a read sends no transaction."
        />
        <ExampleAction
          submit
          icon={<LookupIcon />}
          size="md"
          className={styles.lookupAction}
          does="Looking up will call keyOf on the directory and ink the line it finds."
        >
          Look up
        </ExampleAction>
      </ExampleForm>

      <section className={styles.section} aria-labelledby="live-title">
        <div className={styles.sectionHead}>
          <h2 id="live-title" className={styles.h2}>
            On {DIRECTORY.network} now
          </h2>
          <p className={styles.sectionNote}>
            A real line. The directory at{" "}
            <a className="data" href={DIRECTORY.explorer} target="_blank" rel="noreferrer">
              {shortHex(DIRECTORY.address, 6, 4)}
              <span className="visually-hidden"> (opens the explorer)</span>
            </a>{" "}
            holds one key so far: the deploy smoke test’s test key, derived from random bytes in place of a passkey output.
          </p>
        </div>
        <RegisterTable caption={`Keys posted to the ${DIRECTORY.network} directory`} captionHidden rows={liveRows} />
      </section>

      <section className={styles.section} aria-labelledby="example-title">
        <div className={styles.sectionHead}>
          <h2 id="example-title" className={styles.h2}>
            A busy register <ExampleBadge className={styles.badge} />
          </h2>
          <p className={styles.sectionNote}>
            Example lines made by the SDK, not on chain. The inked line is what a lookup finds; the ruled-through line is an epoch its
            owner has rotated past.
          </p>
        </div>
        <RegisterTable caption="Example register lines" captionHidden rows={exampleRows} />
      </section>

      <aside className={styles.facts} aria-labelledby="facts-title">
        <h2 id="facts-title" className="label-caps">
          The directory
        </h2>
        <dl>
          <div>
            <dt>Contract</dt>
            <dd>
              <a className={`${styles.factLink} data`} href={DIRECTORY.explorer} target="_blank" rel="noreferrer">
                {DIRECTORY.address}
                <ArrowOutIcon size={14} />
                <span className="visually-hidden"> (opens the explorer)</span>
              </a>
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>
              {DIRECTORY.network}, chain {DIRECTORY.chainId}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              Verified with{" "}
              <a href={DIRECTORY.sourceCheck} target="_blank" rel="noreferrer">
                {DIRECTORY.verifier} ({DIRECTORY.match.replace("_", " ")})
                <span className="visually-hidden"> (opens the verification record)</span>
              </a>
            </dd>
          </div>
          <div>
            <dt>Agents</dt>
            <dd>
              {DIRECTORY.agentPathEnabled
                ? "keyOfAgent resolves ERC-8004 agents through the identity registry."
                : "Agent keys are off on testnet: the ERC-8004 identity registry exists on Monad mainnet only."}
            </dd>
          </div>
        </dl>
      </aside>
    </main>
  );
}
