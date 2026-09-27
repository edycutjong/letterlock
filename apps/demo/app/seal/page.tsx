import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { SealDesk } from "./SealDesk";

export const metadata: Metadata = { title: "Seal a note" };

export default async function SealANote({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const to = (await searchParams).to;
  return (
    <main id="main" className="page">
      <PageHead
        title="Seal a note"
        lede="Look up an address in the register and seal to the key on its line. Sealing needs no passkey and no account: anyone can write to a published key, and only the addressee’s passkey opens it."
      />
      <SealDesk initialTo={typeof to === "string" ? to.slice(0, 100) : undefined} />
    </main>
  );
}
