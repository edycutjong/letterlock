# Cross-device passkey test (Mac → iPad, and optionally iPad → Mac)

**Live page: https://letterlock-spike.vercel.app**. Use exactly this address on both devices.

Letterlock turns a passkey's WebAuthn PRF output into an X25519 key. The claim to test: the **same passkey**,
synced through iCloud Keychain, gives the **same key** on a second device, and that device can open a note the
first device sealed. Automation cannot test this. Chrome's DevTools virtual authenticators cannot move a
passkey's `hmac-secret` between devices, so `run-spike.mjs` has to SKIP that check. It needs one person with a
Mac and an iPad, which takes about five minutes.

Status: **waiting for the first human run.**

## What is already known (and why the OS versions matter)

Apple's passkey PRF has two publicly reported problems. Both are forum reports, not reproduced by us.

- **Hybrid use differs.** Using the passkey from another device over a QR code or Bluetooth has returned no PRF
  output, or a different one than on-device, in Safari 18.x
  ([Apple Developer Forums thread 774112](https://developer.apple.com/forums/thread/774112), Feb–Apr 2025).
  The page detects hybrid use and never counts it as a pass.
- **Synced copies can differ by direction and by OS version**
  ([thread 822523](https://developer.apple.com/forums/thread/822523), Apr–Jul 2026, not marked resolved as of
  2026-09-26). Developers report: *"iPhone → Mac: PRF outputs differ. Mac → iPhone: PRF outputs match."* (Jul
  2026), and *"Created on iOS 26.5.2 → used locally on iOS 18.6.2: fails"* (Jul 2026). The same iPhone worked
  after its upgrade to iOS 26. An Apple engineer replied in Apr 2026 that the PRF output "should be identical in
  this case" and asked for bug reports. These reports concern iPhones; that an iPad behaves the same is an
  assumption.

So one run tests one direction on one pair of OS versions. The main run is Mac → iPad, the direction reported
to match. The optional reverse run (iPad → Mac) is the direction reported to fail. If it fails there, a
key first made on an iPhone or iPad would not open notes on a Mac, and Letterlock has to handle that.

## Before you start

- A Mac and an iPad signed in to the **same Apple Account**, with iCloud Keychain (Passwords) turned on.
- **Safari** on both. PRF for iCloud Keychain passkeys needs Safari 18 or later (macOS 15, iPadOS 18).
- **The same OS generation on both devices**: macOS 26 with iPadOS 26, or macOS 15 with iPadOS 18. Note the
  exact versions before you start (Mac: Apple menu → About This Mac; iPad: Settings → General → About), because
  Safari hides them from the page. A mixed pair, such as macOS 26 with iPadOS 18, is a different test. Run it if
  that is what you have, but label the result **mixed versions**.
- Both devices must show the same **Passkey address (rpId)** at the top of the page. Passkeys only work at
  the address they were made on.

## Steps (main run: Mac → iPad)

**On the Mac**

1. Open https://letterlock-spike.vercel.app in Safari.
2. Tap **1 · Create**. Touch ID asks to save a passkey. Accept it, so it is saved to iCloud Keychain.
3. The page shows a large fingerprint (four groups of four characters), the number of passkey prompts it took,
   the passkey's name (for example `maya 14:05 · k3f`), and a QR code.
4. **Self-check:** tap **2 · Use my passkey** once, on the Mac (its card now reads *On this Mac: self-check*). Touch ID asks again. The page must show the same
   fingerprint, open the note, and say *Self-check passed*. This rules out a difference between creating the
   passkey and signing in with it on the Mac itself, which the iPad could not tell apart from a sync problem.
   The QR code stays on screen (it also comes back if you reload the page). Leave this screen open.

**On the iPad**

5. Wait until the passkey arrives. Open the **Passwords** app and search `letterlock-spike`. It usually syncs
   within a minute.
6. Point the **Camera** at the Mac's QR code and open the link in Safari. You can also use **Copy link** or
   **Share…** on the Mac to AirDrop the link. The page should say *A sealed note is in this link*.
7. Tap **2 · Use my passkey**, choose the passkey named on the Mac's screen, and confirm with Face ID or
   Touch ID. Pick the copy **saved on the iPad**. Do not pick "use a passkey from another device" (a QR code or a
   nearby iPhone): that hybrid route does not test the sync, and the page flags it as *Passkey used from:
   ANOTHER device*.
8. Compare the iPad's large fingerprint with the Mac's, by eye. The note from the Mac must appear under it.

**Send back:** tap **Copy result** on both devices and send the texts (by Messages, Notes or email), with the
exact macOS and iPadOS versions. If something fails, tap **Copy details** in the red box instead.

Afterwards you can delete the test passkeys (`maya HH:MM · xyz`) in the Passwords app. Every tap of
*1 · Create* adds a new one, with a different three-character ending.

## Optional reverse run (iPad → Mac)

This tests the direction that thread 822523 reports as failing. Run it after the main run.

1. On the iPad, open https://letterlock-spike.vercel.app **without** a link and tap **1 · Create**. The page
   allows this for the reverse run. Accept Face ID or Touch ID so the passkey is saved to iCloud Keychain.
2. Self-check: tap **2 · Use my passkey** once on the iPad. It must show the same fingerprint and open the note.
3. Send the link to the Mac with **Share…** (AirDrop) or **Copy link**. The Mac's camera cannot read the QR code.
4. On the Mac, wait until the passkey shows in the Passwords app, open the link in Safari, tap
   **2 · Use my passkey**, and pick the passkey named on the iPad (the copy saved on the Mac). The Mac still
   holds the hint for its own main-run passkey; the page says so, and says that this note is sealed to another
   key, so the passkey is looked up by name.
5. Compare the fingerprints and send both **Copy result** texts, labelled *reverse run*, with both OS versions.

## Reading the result

| The page says | Meaning |
|---|---|
| iPad: **PASS**: *Same key — the note opened on this device.* | On these two OS versions, a passkey created on the Mac re-derived the identical key on this iPad and opened the Mac's note. It says nothing about the reverse direction or about other OS versions. |
| Mac: **PASS**: *Self-check passed…* | Creating the passkey and signing in with it give the same key on the Mac. Go on to the iPad. |
| Mac: **FAIL**: *Same passkey on the device that made it, but a DIFFERENT key* | On the Mac itself, the PRF output at sign-in differs from the one at creation. That is not a sync problem. Send this result before you test the iPad. |
| **RETRY**: *The note opened, but through ANOTHER device (hybrid / QR)…* | The key was right, but it came from another device, so the synced copy on this one was never used. It does **not** count as a PASS. Wait for sync, tap 2 again, and pick the copy saved here. |
| **RETRY**: *A different passkey was chosen.* | Another passkey was picked in the sheet. Tap 2 again and pick the one named on the other device. |
| **RETRY**: *The passkey was used from ANOTHER device (hybrid / QR)…* | Hybrid use without the note opening. Wait for sync, then tap 2 again. |
| **FAIL**: *Same passkey as the other device, but a DIFFERENT key* | The same passkey gave a different PRF output on the two devices. With **different OS generations**, this matches the Apple issue reported in thread 822523 rather than a Letterlock defect, so the result is labelled *mixed versions*. With the **same OS generation**, the cross-device claim fails for that direction. |
| `PRF_UNSUPPORTED` | This browser or passkey provider returns no PRF output (older Safari, or a third-party password manager). |
| `PASSKEY_FAILED` | The prompt was cancelled, or the passkey has not synced yet. Wait, then tap again. |
| `DAMAGED_LINK` | The link was cut off. Open it again from the other device. |

What the detail lines record:

- **Passkey prompts** (on the device that created the passkey) is either *1 — the PRF output came with the
  creation* or *2 — … needed a second prompt (mera's fallback assertion)*. `docs/SPEC.md` §4 allows either path;
  this line records which one Safari takes. If Safari blocks the second prompt, the page keeps the new passkey
  and asks for one more tap.
- **Lookup** on the device that opens the link must start with *discoverable*: nothing from the other device is
  stored there, so the passkey is picked by name in the system passkey sheet. It reads *no passkey hint saved in
  this browser* on a device that never made a test passkey, and *this browser's saved passkey hint does not match
  this note's key* on one that did, such as the Mac in the reverse run. *Credential hint* only appears on the
  device that created the passkey (the self-check).
- **Passkey used from** must be *this device*. It comes from the credential's `authenticatorAttachment`:
  `platform` means on-device, and `cross-platform` means hybrid or a security key.
- **Device** and **User agent** come from the browser's own `navigator.userAgent`. iPadOS Safari reports a Mac
  user agent, so the page detects an iPad from touch support. This is a best-effort guess, and the user agent
  does not carry the OS version, which is why you add it by hand.

## Limits, stated plainly

- **The rpId is `location.hostname`.** That is acceptable for this test page only, and the page says so. Production
  pins one rpId (`docs/SPEC.md` §6), and passkeys made here will not work on the production domain.
- **Nothing is onchain.** The note's header (chain 10143, directory `0x…aa`, recipient `0x…01`) is a placeholder,
  and the page reads nothing from Monad and writes nothing to it. The note is sealed to the creating device's own key.
- **The link carries only the sealed note.** It has the form `#env=<base64url JSON envelope>`, with `&cid` and
  `&who` added only to diagnose a failed open. Browsers never send the part after `#` to the server, and the note
  can only be opened with the passkey.
- **The note is limited to 200 bytes**, counted live under the field and checked before any prompt, on
  *1 · Create* and on *2 · Use my passkey* when that tap seals a new note. This keeps the QR code scannable. Emoji
  and Chinese, Japanese or Korean characters take 3–4 bytes each. The link's length also depends on the address
  and the credential ID, so the QR version does too. Measured by `check-page.mjs` on the live page with
  Chromium's 43-character credential IDs: the default note gives a 517-character link and a version-18 code
  (503 characters and version 17 on `localhost`), and a 200-byte note gives version 23. jsQR decodes all of them
  from the page; whether an iPad camera reads the denser ones off a Mac screen is untested.
- **How prompts are counted.** The page watches `navigator.credentials.create/get`. It never changes a request or
  a result. mera 0.2.0 does not export its browser `WebAuthnClient`, and a wrapping client would have replaced
  mera's client with a copy. Watching the browser calls instead keeps mera's own code under test. The automated
  check compares this count with Chromium's own authenticator log.
- **Leave the developer P256 check alone during this test.** It creates a second passkey, `maya-bind`.

## Automated checks

```sh
pnpm --filter prf-browser-spike typecheck    # tsc --strict over the page, its modules and the unit tests
pnpm --filter prf-browser-spike test:unit    # node:test: verdicts, passkey names, note limit, build stamp, planning-file names (files and history)
pnpm --filter prf-browser-spike test         # the unit tests, then run-spike.mjs (dev server, real Monad RPC for the P256 checks)
pnpm --filter prf-browser-spike check:page   # check-page.mjs: taps the real buttons on the production build
node check-page.mjs --url https://letterlock-spike.vercel.app/   # the same checks against the live page
```

Results on 2026-09-26 with Chromium 153 virtual authenticators, page build `77d39d6`:

- `pnpm typecheck` (the SDK and this page, `tsc --strict`): no errors.
- `test:unit`: **29/29**.
- `check-page.mjs`: **40/40** on the local production build and **41/41** on the live page; the live run adds the
  CSP header check. (An earlier round, against live build `d657646`, had 9 of its checks fail, each on a defect
  fixed since.)
- `run-spike.mjs`: **13/14 passed, 1 SKIP**. The SKIP is the cross-device check, which is this human run.
- The SDK's own suite (`pnpm --filter letterlock test`): **59/59**.

Not everything is covered by `check-page.mjs`: the build stamp, the strict typecheck and the planning-file
names are covered by the unit tests and `tsc`. (Commit `209dfd6` said check-page covered every finding of that
audit; that overstated it.) `check-page.mjs` covers the following:
- the rpId shown on the page with its test-only caveat, and the fingerprint matching the note's `kid`;
- the QR code decoding (jsQR) to exactly the link, also for a 200-byte note, and coming back after the
  self-check and after a reload on the creating device;
- the prompt count against Chromium's authenticator log (CDP `WebAuthn.credentialAdded`/`credentialAsserted`),
  so an observer that missed or double-counted a prompt would fail;
- credential-hint (self-check) and discoverable opens, and the Lookup wording, also when the browser holds a hint
  for another passkey;
- on the creating device, step 2 reads *On this Mac: self-check* after 1 · Create and after a reload, and the
  banner calls the note this device's own;
- two passkeys created at one fixed instant get different names;
- the note's byte limit, shown live and enforced before any prompt on both buttons, and the verdict when a tap
  seals a new note;
- the default note's QR code decoding to exactly the link;
- an iPad user agent: the reverse run is offered, and its hand-off targets the Mac;
- the wrong-passkey diagnosis, and readable `PRF_UNSUPPORTED` and damaged-link states;
- Copy result, and no sideways scroll at iPad and phone widths;
- no page errors or CSP errors.

Chromium always returns PRF at creation, and its virtual authenticator never refuses a prompt. So six cases
are checked by *simulating* the authenticator behaviour in a test-only init script:
- the 2-prompt fallback;
- a blocked second prompt: the page keeps the passkey, and one more tap finishes;
- a hybrid assertion that returns a different PRF value: the page diagnoses it as hybrid, not as a failure;
- a hybrid assertion that returns the same PRF value: the note opens, but the verdict is RETRY, not PASS;
- a PRF output at creation that differs from the one at sign-in: the self-check FAILs as "not a sync problem";
- a Touch ID prompt cancelled during *1 · Create*: the page asks for another tap on the Mac.

## Build and deploy

```sh
# from spikes/prf-browser
pnpm build                              # → dist/ (git-ignored), stamped by build-stamp.ts
DEPLOY=$(mktemp -d) && cp -R dist/. vercel.json "$DEPLOY"/
cd "$DEPLOY" && vercel link --yes --project letterlock-spike && vercel deploy --prod --yes
```

The build stamp is the last commit that changed the page, the SDK it bundles, or `pnpm-lock.yaml`, plus
`+dirty` when any of them has uncommitted changes. Markdown is ignored. Commits elsewhere in the repo leave it
unchanged.

The deploy is static files only, with no environment variables and no secrets. `vercel.json` sets a self-only
Content-Security-Policy, `Referrer-Policy: no-referrer`, `nosniff`, and a Permissions-Policy that limits passkeys to
this origin. Only the production address is public; each deployment's own URL redirects to Vercel's login.
