import type { Metadata } from "next";
import { InboxDesk } from "./InboxDesk";

export const metadata: Metadata = { title: "Inbox" };

export default async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const to = (await searchParams).to;
  return <InboxDesk initialTo={typeof to === "string" ? to.slice(0, 100) : undefined} />;
}
