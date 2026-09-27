import type { Metadata } from "next";
import { ArrowOutIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { DIRECTORY } from "@/lib/deployment.ts";
import { RegisterLive } from "./RegisterLive";
import { SourceCheck } from "./SourceCheck";
import styles from "./register.module.css";

export const metadata: Metadata = { title: "The register" };

export default async function Register({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = (await searchParams).q;
  return (
    <main id="main" className="page">
      <PageHead
        title="The register"
        lede="Every key posted to the directory. Anyone may read it: find an address, then seal to the key on its line. When someone rotates, their earlier line stays in the register, ruled through."
      />

      <RegisterLive initialQuery={typeof q === "string" && q.trim() ? q.trim().slice(0, 100) : undefined} />

      <aside className={styles.facts} aria-labelledby="facts-title">
        <h2 id="facts-title" className="label-caps">
          The directory
        </h2>
        <dl>
          <div>
            <dt>Contract</dt>
            <dd>
              <a className={`${styles.factLink} data`} href={DIRECTORY.explorer} target="_blank" rel="noreferrer">
                {DIRECTORY.address.slice(0, -4)}
                {/* the arrow never starts a line of its own: it stays with the address's last four digits */}
                <span className={styles.tail}>
                  {DIRECTORY.address.slice(-4)}
                  <ArrowOutIcon size={14} />
                </span>
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
              <SourceCheck />
            </dd>
          </div>
          <div>
            <dt>Agents</dt>
            <dd>
              {DIRECTORY.agentPathEnabled
                ? "keyOfAgent resolves ERC-8004 agents through the identity registry, while the key’s publisher still owns the agent."
                : "Agent keys are off on testnet: the ERC-8004 identity registry exists on Monad mainnet only."}
            </dd>
          </div>
        </dl>
      </aside>
    </main>
  );
}
