// A fresh nonce for every page: Next.js reads it from the request's Content-Security-Policy header and puts it on the
// scripts it renders, and the response carries the same policy (lib/csp.ts).
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/csp.ts";

export function middleware(request: NextRequest) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", https: request.nextUrl.protocol === "https:" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // pages only: not the API, not the build's static files, not the images and icons in public/
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|og-image\\.png|icon\\.svg|favicon\\.ico|robots\\.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
