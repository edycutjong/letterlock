"use client";

import { useEffect, useState } from "react";
import styles from "./QrCode.module.css";

type Matrix = { size: number; dark: boolean[] };

/**
 * A QR code of `text`, drawn as one SVG path in ink on the letter sheet (no image, no canvas, nothing inline to
 * allow in the page's security policy). The code is made in the browser, after the page loads.
 */
export function QrCode({ text, label, size = 176, className }: { text: string; label: string; size?: number; className?: string }) {
  const [m, setM] = useState<Matrix | undefined>(undefined);
  useEffect(() => {
    let live = true;
    import("qrcode").then(({ create }) => {
      const q = create(text, { errorCorrectionLevel: "M" });
      const dark: boolean[] = [];
      for (let r = 0; r < q.modules.size; r++) for (let c = 0; c < q.modules.size; c++) dark.push(Boolean(q.modules.get(r, c)));
      if (live) setM({ size: q.modules.size, dark });
    });
    return () => {
      live = false;
    };
  }, [text]);
  const quiet = 4;
  const n = (m?.size ?? 25) + quiet * 2;
  let d = "";
  if (m) for (let i = 0; i < m.dark.length; i++) if (m.dark[i]) d += `M${(i % m.size) + quiet} ${Math.floor(i / m.size) + quiet}h1v1h-1z`;
  return (
    <svg
      className={[styles.qr, className].filter(Boolean).join(" ")}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-ready={m ? "" : undefined}
    >
      <rect width={n} height={n} className={styles.paper} />
      {m && <path d={d} className={styles.ink} />}
    </svg>
  );
}
