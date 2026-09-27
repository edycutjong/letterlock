// the token sheet and the base layer first, before any component brings its own stylesheet
import "./tokens.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { DevBanner } from "@/components/DevBanner";
import { LETTERLOCK_RP_ID } from "@/lib/chain.ts";
import { DIRECTORY } from "@/lib/deployment.ts";
import { tokenValue } from "@/lib/tokens.ts";

// Display: engraved-stationery Didone with a true italic for address lines; its optical-size axis keeps the
// hairlines sturdy at 15 px and fine at 60 px. Body: a plain civil-service sans, like postal forms. Data: mono, for
// fingerprints, hashes and envelope JSON only. Each family ships only the styles and weights the pages are set in:
// every one is preloaded on every page (scripts/checks/font-preloads.mjs).
const display = Bodoni_Moda({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
  variable: "--nf-display",
});

const body = Public_Sans({
  subsets: ["latin"],
  style: ["normal"],
  display: "swap",
  variable: "--nf-body",
});

const data = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  variable: "--nf-data",
});

const TITLE = "Letterlock: a passkey becomes an encryption address";
const DESCRIPTION =
  "Your passkey derives an encryption key and posts its public half to a register on Monad. Anyone can seal a note to your address; only your passkey opens it, on any device it syncs to.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${LETTERLOCK_RP_ID}`),
  title: {
    default: TITLE,
    template: "%s · Letterlock",
  },
  description: DESCRIPTION,
  applicationName: "Letterlock",
  openGraph: {
    type: "website",
    siteName: "Letterlock",
    url: "/",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og-image.png", width: 2400, height: 1260, alt: "Letterlock: a wax seal pressed over an address line on a manila envelope" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
};

// Every page is rendered per request: its scripts carry that request's CSP nonce (middleware.ts).
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  themeColor: tokenValue("--bg"),
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="margin-rule" aria-hidden="true" />
        <DevBanner />
        <SiteHeader network={DIRECTORY.network} chainId={DIRECTORY.chainId} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
