# Cross-device passkey test (Mac → iPad)

**Live page: https://letterlock-spike.vercel.app**. Use exactly this address on both devices.

Letterlock turns a passkey's WebAuthn PRF output into an X25519 key. The claim to prove: the **same passkey**,
synced through iCloud Keychain, gives the **same key** on a second device, and that device can open a note the
first device sealed. Automation cannot prove this. Chrome's DevTools virtual authenticators cannot move a
passkey's `hmac-secret` between devices, so `run-spike.mjs` has to SKIP that check. It needs one person with a
Mac and an iPad, which takes about five minutes.

Status: **waiting for the first human run.**

## Before you start

- A Mac and an iPad signed in to the **same Apple Account**, with iCloud Keychain (Passwords) turned on.
- **Safari** on both, and it must be recent. PRF for iCloud Keychain passkeys needs Safari 18 or later (macOS 15,
  iPadOS 18); use the newest macOS and iPadOS you have. The page's *Passkey PRF support* line shows what each
  browser reports.
- Both devices must show the same **Passkey address (rpId)** at the top of the page. Passkeys only work at
  the address they were made on.

## Steps

**On the Mac**

1. Open https://letterlock-spike.vercel.app in Safari.
2. Tap **1 · Create**. Touch ID asks to save a passkey. Accept it, so it is saved to iCloud Keychain.
3. The page shows a large fingerprint (four groups of four characters), the number of passkey prompts it took,
   the passkey's name (for example `maya 14:05`), and a QR code. Leave this screen open.

**On the iPad**

4. Wait until the passkey arrives. Open the **Passwords** app and search `letterlock-spike`. It usually syncs
   within a minute.
5. Point the **Camera** at the Mac's QR code and open the link in Safari. You can also use **Copy link** or
   **Share…** on the Mac to AirDrop the link. The page should say *A sealed note is in this link*.
6. Tap **2 · Use my passkey**, choose the passkey named on the Mac's screen, and confirm with Face ID or
   Touch ID. Pick the copy **saved on the iPad**. Do not pick "use a passkey from another device" (a QR code or a
   nearby iPhone). Over that hybrid route, Safari 18.x has returned no PRF output, or a different one, than
   on-device ([Apple Developer Forums](https://developer.apple.com/forums/thread/774112)). A hybrid run would not
   test the sync, so the page flags it as *Passkey used from: ANOTHER device*.
7. Compare the iPad's large fingerprint with the Mac's, by eye. The note from the Mac must appear under it.

**Send back:** tap **Copy result** on both devices and send the two texts (by Messages, Notes or email). If
something fails, tap **Copy details** in the red box instead. Please also add the macOS and iPadOS versions,
because Safari hides them: on the Mac, Apple menu → About This Mac; on the iPad, Settings → General → About.

Afterwards you can delete the test passkeys (`maya HH:MM`) in the Passwords app. Every tap of *1 · Create* adds
a new one.

## Reading the result

| The iPad says | Meaning |
|---|---|
| **PASS**: *Same key — the note opened on this device.* | The synced passkey re-derived the identical key. The cross-device claim holds. |
| **RETRY**: *A different passkey was chosen.* | Another passkey was picked in the sheet. Tap 2 again and pick the one named on the Mac. |
| **RETRY**: *The passkey was used from ANOTHER device (hybrid / QR)…* | The iPad borrowed the passkey from another device instead of its synced copy. Wait for sync, then tap 2 again. |
| **FAIL**: *Same passkey as the other device, but a DIFFERENT key* | The critical finding: the PRF output is not stable across devices. |
| `PRF_UNSUPPORTED` | This browser or passkey provider returns no PRF output (older Safari, or a third-party password manager). |
| `PASSKEY_FAILED` | The prompt was cancelled, or the passkey has not synced yet. Wait, then tap again. |
| `DAMAGED_LINK` | The link was cut off. Scan the QR code again. |

What the detail lines record:

- **Passkey prompts** (on the Mac) is either *1 — the PRF output came with the creation* or *2 — … needed a second
  prompt (mera's fallback assertion)*. `docs/SPEC.md` §4 allows either path; this line records which one
  Safari takes. If Safari blocks the second prompt, the page keeps the new passkey and asks for one more tap.
- **Lookup** (on the iPad) must be *discoverable*. The iPad has nothing stored from the Mac, so the passkey is
  found through the system passkey sheet. *Credential hint* only appears on the device that created the passkey.
- **Passkey used from** (on the iPad) must be *this device*. It comes from the credential's
  `authenticatorAttachment`: `platform` means on-device, and `cross-platform` means hybrid or a security key.
- **Device** and **User agent** come from the browser's own `navigator.userAgent`. iPadOS Safari reports a Mac
  user agent, so the page detects an iPad from touch support. This is a best-effort guess.

## Limits, stated plainly

- **The rpId is `location.hostname`.** That is fine for this test page. Production pins one rpId
  (`docs/SPEC.md` §6), and passkeys made here will not work on the production domain.
- **Nothing is onchain.** The note's header (chain 10143, directory `0x…aa`, recipient `0x…01`) is a placeholder,
  and the page reads nothing from Monad and writes nothing to it. The note is sealed to the Mac's own key.
- **The link carries only the sealed note.** It has the form `#env=<base64url JSON envelope>`, with `&cid` and
  `&who` added only to diagnose a failed open. Browsers never send the part after `#` to the server, and the note
  can only be opened with the passkey.
- **How prompts are counted.** The page watches `navigator.credentials.create/get`. It never changes a request or
  a result. mera 0.2.0 does not export its browser `WebAuthnClient`, and a wrapping client would have replaced
  mera's client with a copy. Watching the browser calls instead keeps mera's own code under test.
- **Leave the developer P256 check alone during this test.** It creates a second passkey, `maya-bind`.

## Automated checks

```sh
pnpm --filter prf-browser-spike test         # run-spike.mjs, dev server, real Monad RPC for the P256 checks
pnpm --filter prf-browser-spike check:page   # check-page.mjs: taps the real buttons on the production build
node check-page.mjs --url https://letterlock-spike.vercel.app/   # the same checks against the live page
```

Results on 2026-09-26 with Chromium 153 virtual authenticators:

- `run-spike.mjs`: **13/14 passed, 1 SKIP**. The SKIP is the cross-device check, which is this human run.
- `check-page.mjs`: **24/24** on the local production build and **25/25** on the live page (build `7f63af7`); the
  live run adds the CSP header check.
- The SDK's own suite (`pnpm --filter letterlock test`): **59/59**.

`check-page.mjs` covers the following:
- the rpId shown on the page, and the fingerprint matching the note's `kid`;
- the QR code decoding (jsQR) to exactly the link;
- credential-hint and discoverable opens;
- the wrong-passkey diagnosis, and readable `PRF_UNSUPPORTED` and damaged-link states;
- Copy result, and no sideways scroll at iPad and phone widths;
- no page errors or CSP errors.

Chromium always returns PRF at creation. So three cases are checked by *simulating* the authenticator
behaviour in a test-only init script:
- the 2-prompt fallback;
- a blocked second prompt: the page keeps the passkey, and one more tap finishes;
- a hybrid assertion that returns a different PRF value: the page diagnoses it as hybrid, not as a failure.

## Build and deploy

```sh
# from spikes/prf-browser
pnpm build                              # → dist/ (git-ignored), stamped with the commit it was built from
DEPLOY=$(mktemp -d) && cp -R dist/. vercel.json "$DEPLOY"/
cd "$DEPLOY" && vercel link --yes --project letterlock-spike && vercel deploy --prod --yes
```

The deploy is static files only, with no environment variables and no secrets. `vercel.json` sets a self-only
Content-Security-Policy, `Referrer-Policy: no-referrer`, `nosniff`, and a Permissions-Policy that limits passkeys to
this origin. Only the production address is public; each deployment's own URL redirects to Vercel's login.
