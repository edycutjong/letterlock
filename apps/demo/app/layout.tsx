// the token sheet and the base layer first, before any component brings its own stylesheet
import "./tokens.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { DIRECTORY } from "@/lib/deployment.ts";

// Display: engraved-stationery Didone with a true italic for address lines; its optical-size axis keeps the
// hairlines sturdy at 15 px and fine at 60 px. Body: a plain civil-service sans, like postal forms. Data: mono, for
// fingerprints, hashes and envelope JSON only.
const display = Bodoni_Moda({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
  variable: "--nf-display",
});

const body = Public_Sans({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--nf-body",
});

const data = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--nf-data",
});

export const metadata: Metadata = {
  title: {
    default: "Letterlock: a passkey becomes an encryption address",
    template: "%s · Letterlock",
  },
  description:
    "Your passkey derives an encryption key and posts its public half to a register on Monad. Anyone can seal a note to your address; only your passkey opens it, on any device it syncs to.",
  applicationName: "Letterlock",
};

export const viewport: Viewport = {
  themeColor: "#F3EEE3",
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
        <SiteHeader network={DIRECTORY.network} chainId={DIRECTORY.chainId} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
