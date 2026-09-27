"use client";

import { useEffect, useState } from "react";
import { DIRECTORY } from "@/lib/deployment.ts";

/**
 * The directory's source verification, asked of the Sourcify server the deploy record names, when the page loads.
 * Until it answers (or if it cannot), the page says what the deploy record says, and that it is the record.
 */
export function SourceCheck() {
  const [live, setLive] = useState<{ match?: string; failed?: boolean }>({});
  useEffect(() => {
    const ctl = new AbortController();
    fetch(DIRECTORY.sourceCheck, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { match?: unknown; runtimeMatch?: unknown }) => {
        const match = typeof j.match === "string" ? j.match : typeof j.runtimeMatch === "string" ? j.runtimeMatch : undefined;
        setLive(match ? { match } : { failed: true });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLive({ failed: true });
      });
    return () => ctl.abort();
  }, []);
  const said = live.match ?? DIRECTORY.match;
  return (
    <>
      Verified with{" "}
      <a href={DIRECTORY.sourceCheck} target="_blank" rel="noreferrer">
        {DIRECTORY.verifier} ({said.replace("_", " ")})
        <span className="visually-hidden"> (opens the verification record)</span>
      </a>
      {live.match ? ", checked just now" : live.failed ? ", as the deploy record says (Sourcify did not answer now)" : ""}
    </>
  );
}
