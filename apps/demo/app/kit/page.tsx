import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AddressCard } from "@/components/AddressCard";
import { Button, ButtonLink } from "@/components/Button";
import { Envelope, Letter } from "@/components/Envelope";
import { ErrorSlip } from "@/components/ErrorSlip";
import { ExampleBadge, ExampleNote } from "@/components/ExampleBadge";
import { NoteField, TextField } from "@/components/Field";
import { ArrowRightIcon, EnvelopeIcon, PasskeyIcon } from "@/components/Icons";
import { KeyStrip } from "@/components/KeyStrip";
import { PageHead } from "@/components/PageHead";
import { PasskeyButton } from "@/components/PasskeyButton";
import { Postmark } from "@/components/Postmark";
import { RegisterTable, type RegisterRow } from "@/components/RegisterTable";
import { CRACK_MS, PRESS_MS, WaxSeal } from "@/components/WaxSeal";
import { Wordmark } from "@/components/Wordmark";
import { TESTNET_TEST_KEY } from "@/lib/deployment.ts";
import { SLIP_CODES } from "@/lib/error-copy.ts";
import { EXAMPLE_AGENTS, currentKey, failureValues, letter, persona } from "@/lib/examples.ts";
import { postmarkDate } from "@/lib/format.ts";
import { groupFingerprint } from "@/lib/keystrip.ts";
import { EnvelopeReplay, SealReplay } from "./Replay";
import styles from "./kit.module.css";

export const metadata: Metadata = { title: "Component kit" };

const SECTIONS = [
  { id: "tokens", label: "Colour and type" },
  { id: "wax-seal", label: "WaxSeal" },
  { id: "envelope", label: "Envelope" },
  { id: "address-card", label: "AddressCard" },
  { id: "register-table", label: "RegisterTable" },
  { id: "error-slip", label: "ErrorSlip" },
  { id: "buttons", label: "PasskeyButton" },
  { id: "marks", label: "Postmark, strip, stamp" },
  { id: "fields", label: "Fields" },
] as const;

const COLOURS = [
  { name: "Manila", token: "--bg", hex: "#F3EEE3", use: "the page: envelope stock" },
  { name: "Letter sheet", token: "--bg-elevated", hex: "#F8F4EB", use: "cards, slips, the letter" },
  { name: "Inner fold", token: "--bg-sunk", hex: "#ECE6D9", use: "inside the envelope" },
  { name: "Iron-gall ink", token: "--ink", hex: "#1E1B16", use: "text, rules, primary buttons" },
  { name: "Pencil", token: "--muted", hex: "#6E6556", use: "secondary text, labels" },
  { name: "Ruling", token: "--rule", hex: "#CFC4AF", use: "register hairlines" },
  { name: "Airmail blue", token: "--before", hex: "#2F5D9E", use: "open state: a public key, a letter going out" },
  // colour-law: label. The hex is printed as text; the swatch itself is drawn as a WaxSeal.
  { name: "Sealing wax", token: "--after", hex: "#A3261E", use: "only as wax: the seal and the word “lock”", wax: true },
] as const;

function Specimen({ name, detail, children, wide, plain }: { name: string; detail?: ReactNode; children: ReactNode; wide?: boolean; plain?: boolean }) {
  return (
    <figure className={styles.specimen} data-wide={wide ? "" : undefined}>
      <div className={styles.plate} data-plain={plain ? "" : undefined}>
        {children}
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.captionName}>{name}</span>
        {detail && <span className={styles.captionDetail}>{detail}</span>}
      </figcaption>
    </figure>
  );
}

function Section({ id, title, lede, children }: { id: string; title: string; lede: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <header className={styles.sectionHead}>
        <h2 id={`${id}-title`} className={styles.h2}>
          {title}
        </h2>
        <p className={styles.sectionLede}>{lede}</p>
      </header>
      {children}
    </section>
  );
}

export default function Kit() {
  const maya = persona("Maya");
  const mayaKey = currentKey(maya);
  const kai = persona("Kai");
  const nadia = persona("Nadia");
  const agent = EXAMPLE_AGENTS[0]!;
  const note = letter("maya-dentist");
  const pressFrames = [0, 70, 140, 210, PRESS_MS];
  const crackFrames = [0, 140, 280, 420, CRACK_MS];

  const rows: RegisterRow[] = [
    { id: "a", addressee: agent.recipient, epoch: 1, fingerprint: agent.keys[0]!.fingerprint, posted: { kind: "example" }, example: true },
    { id: "k2", addressee: kai.address, epoch: 2, fingerprint: kai.keys[1]!.fingerprint, posted: { kind: "example" }, example: true },
    { id: "m", addressee: maya.address, epoch: 1, fingerprint: mayaKey.fingerprint, posted: { kind: "example" }, state: "found", example: true },
    { id: "n", addressee: nadia.address, epoch: 1, fingerprint: nadia.keys[0]!.fingerprint, posted: { kind: "example" }, example: true },
    { id: "k1", addressee: kai.address, epoch: 1, fingerprint: kai.keys[0]!.fingerprint, posted: { kind: "example" }, state: "superseded", example: true },
  ];
  const liveRow: RegisterRow = {
    id: "live",
    addressee: TESTNET_TEST_KEY.address,
    epoch: TESTNET_TEST_KEY.epoch,
    fingerprint: TESTNET_TEST_KEY.fingerprint,
    posted: { kind: "tx", hash: TESTNET_TEST_KEY.txHash, href: TESTNET_TEST_KEY.txUrl, block: TESTNET_TEST_KEY.block, network: "Testnet" },
    note: "Test key: random bytes stood in for a passkey",
  };

  return (
    <main id="main" className="page">
      <PageHead
        title={
          <>
            Component kit: <em>every state, as the pages use it.</em>
          </>
        }
        lede="The postal register’s parts, each drawn in every state it can be in. Red appears only in wax: the seal, and the word “lock”. Airmail blue marks what is open. Everything else is ink, pencil and ruling on manila."
        example="Addresses, keys and letters here are examples made by the SDK. The testnet key and its transaction link are real."
      />

      <div className={styles.layout}>
        <nav className={styles.index} aria-label="Components">
          <p className="label-caps">Contents</p>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.sections}>
          <Section id="tokens" title="Colour and type" lede="Six brand values and their surfaces. The wax is a state, not a decoration: it appears when a seal presses shut and when it breaks.">
            <ul className={styles.swatches}>
              {COLOURS.map((c) => (
                <li key={c.token} className={styles.swatch}>
                  {"wax" in c ? (
                    <span className={styles.chipWax}>
                      <WaxSeal state="pressed" size={44} decorative />
                    </span>
                  ) : (
                    <span className={styles.chip} style={{ background: `var(${c.token})` }} />
                  )}
                  <span className={styles.swatchName}>{c.name}</span>
                  <code className="data">
                    {c.token} {c.hex}
                  </code>
                  <span className={styles.swatchUse}>{c.use}</span>
                </li>
              ))}
            </ul>
            <div className={styles.typeSpecimens}>
              <p className={styles.typeTitle}>Title, Bodoni Moda 44</p>
              <p className={`${styles.typeAddress} address-line`}>Address line, Bodoni Moda italic 30</p>
              <p className={styles.typeBody}>Body, Public Sans 19. Plain words, like a postal form: what happened, and what to do next.</p>
              <p className="data">Data, IBM Plex Mono 15: 6b52 86d1 ad27 08a1 · keyOf(address)</p>
              <p className="label-caps">Label capitals, Public Sans 12</p>
            </div>
          </Section>

          <Section
            id="wax-seal"
            title="WaxSeal"
            lede={
              <>
                Five states. It presses in {PRESS_MS} ms with an overshoot and cracks in {CRACK_MS} ms; with reduced motion the change is
                instant. It appears on the seal and open screens only.
              </>
            }
          >
            <div className={styles.row3}>
              <Specimen name="absent" detail="where the wax will land">
                <WaxSeal state="absent" size={112} />
              </Specimen>
              <Specimen name="pressed" detail="seal() completed">
                <WaxSeal state="pressed" size={112} />
              </Specimen>
              <Specimen name="cracked" detail="open() succeeded">
                <WaxSeal state="cracked" size={112} />
              </Specimen>
            </div>
            <h3 className={styles.h3}>pressing, frame by frame</h3>
            <ol className={styles.film} aria-label="pressing, frame by frame">
              {pressFrames.map((t) => (
                <li key={t}>
                  <WaxSeal state="pressing" freezeAtMs={t} size={96} label={`Pressing, ${t} milliseconds in`} />
                  <span className={styles.frameTime}>{t} ms</span>
                </li>
              ))}
            </ol>
            <h3 className={styles.h3}>cracking, frame by frame</h3>
            <ol className={styles.film} aria-label="cracking, frame by frame">
              {crackFrames.map((t) => (
                <li key={t}>
                  <WaxSeal state="cracking" freezeAtMs={t} size={96} label={`Cracking, ${t} milliseconds in`} />
                  <span className={styles.frameTime}>{t} ms</span>
                </li>
              ))}
            </ol>
            <Specimen name="replay" detail="press it shut, crack it open, at full speed">
              <SealReplay />
            </Specimen>
          </Section>

          <Section
            id="envelope"
            title="Envelope"
            lede="An airmail edge, an italic address line, a flap that is down or folded back, a slot for the seal and one for the letter. The letter exists only before sealing and after opening."
          >
            <div className={styles.row2}>
              <Specimen name="open, unsealed" detail="the letter is readable by whoever carries it">
                <Envelope recipient={maya.address} epoch={1} fingerprint={mayaKey.fingerprint} flap="open">
                  <Letter>
                    <p>{note.text}</p>
                  </Letter>
                </Envelope>
              </Specimen>
              <Specimen name="closed, sealed" detail="only the addressee’s passkey breaks it">
                <Envelope recipient={maya.address} epoch={1} fingerprint={mayaKey.fingerprint} flap="closed" seal={<WaxSeal state="pressed" decorative />} />
              </Specimen>
              <Specimen name="opened" detail="seal cracked, letter out">
                <Envelope recipient={maya.address} epoch={1} fingerprint={mayaKey.fingerprint} flap="open" seal={<WaxSeal state="cracked" decorative />}>
                  <Letter>
                    <p>{note.text}</p>
                  </Letter>
                </Envelope>
              </Specimen>
              <Specimen name="closed, not yet sealed" detail="to an agent; the wax lands on the ring">
                <Envelope recipient={agent.recipient} epoch={1} fingerprint={agent.keys[0]!.fingerprint} flap="closed" seal={<WaxSeal state="absent" decorative />} />
              </Specimen>
              <Specimen name="compact" detail="inbox thumbnails: sealed · opened">
                <div className={styles.compactPair}>
                  <Envelope recipient={maya.address} flap="closed" variant="compact" seal={<WaxSeal state="pressed" decorative />} decorative />
                  <Envelope recipient={maya.address} flap="open" variant="compact" seal={<WaxSeal state="cracked" decorative />} decorative />
                </div>
              </Specimen>
              <Specimen name="replay" detail="seal it, then open it" wide>
                <EnvelopeReplay recipient={maya.address} epoch={1} fingerprint={mayaKey.fingerprint} text={note.text} />
              </Specimen>
            </div>
          </Section>

          <Section id="address-card" title="AddressCard" lede="The address line, the key as a bar strip and in hex, the epoch, and where the key was posted.">
            <div className={styles.row2}>
              <Specimen name="posted" detail="real: the testnet directory’s test key" plain>
                <AddressCard
                  title="Encryption address"
                  headingLevel={3}
                  address={TESTNET_TEST_KEY.address}
                  fingerprint={TESTNET_TEST_KEY.fingerprint}
                  epoch={TESTNET_TEST_KEY.epoch}
                  posted={{
                    kind: "tx",
                    hash: TESTNET_TEST_KEY.txHash,
                    href: TESTNET_TEST_KEY.txUrl,
                    block: TESTNET_TEST_KEY.block,
                    at: TESTNET_TEST_KEY.updatedAt,
                    network: "Monad testnet",
                  }}
                  postmark={{ top: "Monad testnet", bottom: postmarkDate(TESTNET_TEST_KEY.updatedAt), center: String(TESTNET_TEST_KEY.epoch), centerLabel: "Epoch" }}
                  footnote="A test key: the SDK’s derivation over random bytes standing in for a passkey. No passkey was used."
                />
              </Specimen>
              <Specimen name="example" detail="not posted" plain>
                <AddressCard
                  example
                  headingLevel={3}
                  address={maya.address}
                  fingerprint={mayaKey.fingerprint}
                  epoch={mayaKey.epoch}
                  posted={{ kind: "example" }}
                  actions={
                    <Button tone="outline" size="md" icon={<PasskeyIcon />}>
                      Rotate key
                    </Button>
                  }
                />
              </Specimen>
              <Specimen name="rotated" detail="epoch 2; epoch 1 still opens" plain>
                <AddressCard example headingLevel={3} address={kai.address} fingerprint={kai.keys[1]!.fingerprint} epoch={2} posted={{ kind: "example" }} />
              </Specimen>
              <Specimen name="posting" detail="the publish transaction is out" plain>
                <AddressCard example headingLevel={3} address={nadia.address} fingerprint={nadia.keys[0]!.fingerprint} epoch={1} posted={{ kind: "pending" }} />
              </Specimen>
            </div>
          </Section>

          <Section
            id="register-table"
            title="RegisterTable"
            lede="Ruled register columns with tabular numerals. From 1024 px up every column shows; narrower, it keeps addressee, epoch and key."
          >
            <Specimen name="full" detail="found line inked blue · rotated line ruled through · rows stamped Example" plain>
              <RegisterTable caption="Example register, every column" captionHidden rows={rows} layout="full" />
            </Specimen>
            <Specimen name="posted, real" detail="the testnet directory’s one line, with its transaction" plain>
              <RegisterTable caption="Testnet register" captionHidden rows={[liveRow]} layout="full" />
            </Specimen>
            <div className={styles.row2}>
              <Specimen name="compact" detail="below 1024 px: addressee, epoch, key" plain>
                <RegisterTable caption="Example register, compact" captionHidden rows={rows.slice(1, 4).map((r) => ({ ...r, example: false }))} layout="compact" />
              </Specimen>
              <Specimen name="empty" detail="a directory with no keys yet" plain>
                <RegisterTable caption="Empty register" captionHidden rows={[]} layout="compact" empty="No keys in the register yet." />
              </Specimen>
            </div>
          </Section>

          <Section
            id="error-slip"
            title="ErrorSlip"
            lede="A returned-to-sender slip for each SDK error a person can meet: what happened, in plain words, and what to do. Inked, never red."
          >
            <div className={styles.slips}>
              {SLIP_CODES.map((code) => (
                <ErrorSlip
                  key={code}
                  code={code}
                  values={failureValues(code)}
                  example
                  action={
                    code === "PRF_UNSUPPORTED" || code === "PASSKEY_FAILED" || code === "WRONG_KEY" || code === "EPOCH_MISMATCH" ? (
                      <PasskeyButton tone={code === "EPOCH_MISMATCH" ? "airmail" : "ink"} size="md">
                        {code === "PRF_UNSUPPORTED" ? "Try another passkey" : code === "PASSKEY_FAILED" ? "Try again" : code === "WRONG_KEY" ? "Choose another passkey" : "Open with passkey"}
                      </PasskeyButton>
                    ) : code === "NO_KEY_PUBLISHED" ? (
                      <ButtonLink href="/register" size="md" icon={<ArrowRightIcon />}>
                        Look them up again
                      </ButtonLink>
                    ) : undefined
                  }
                />
              ))}
            </div>
            <ExampleNote>
              The quoted keys and epochs are what the SDK’s open() really reports for example letters: Maya’s letter opened with
              Nadia’s passkey, and Kai’s epoch 1 letter with his epoch 2 key.
            </ExampleNote>
          </Section>

          <Section
            id="buttons"
            title="PasskeyButton"
            lede="The one primary action on a screen that raises a passkey prompt. Ink, or airmail blue when it opens a letter; never red. While the prompt is up it keeps focus and says what it waits for."
          >
            <div className={styles.buttonGrid}>
              {(["ink", "airmail"] as const).map((tone) => {
                const label = tone === "ink" ? "Create my encryption address" : "Open with passkey";
                return (
                  <div key={tone} className={styles.buttonCol} role="group" aria-label={`${tone} PasskeyButton states`}>
                    <p className="label-caps">{tone}</p>
                    <Specimen name="idle">
                      <PasskeyButton tone={tone}>{label}</PasskeyButton>
                    </Specimen>
                    <Specimen name="hover">
                      <PasskeyButton tone={tone} force="hover">
                        {label}
                      </PasskeyButton>
                    </Specimen>
                    <Specimen name="focus" detail="keyboard">
                      <PasskeyButton tone={tone} force="focus">
                        {label}
                      </PasskeyButton>
                    </Specimen>
                    <Specimen name="pressed">
                      <PasskeyButton tone={tone} force="active">
                        {label}
                      </PasskeyButton>
                    </Specimen>
                    <Specimen name="waiting" detail="the prompt is up">
                      <PasskeyButton tone={tone} status="waiting">
                        {label}
                      </PasskeyButton>
                    </Specimen>
                    <Specimen name="disabled">
                      <PasskeyButton tone={tone} status="disabled">
                        {label}
                      </PasskeyButton>
                    </Specimen>
                  </div>
                );
              })}
            </div>
            <h3 className={styles.h3}>Other actions, same stamp</h3>
            <div className={styles.row3} role="group" aria-label="Other button states">
              <Specimen name="ink" detail="no prompt">
                <Button>Seal</Button>
              </Specimen>
              <Specimen name="airmail" detail="a letter going out">
                <Button tone="airmail" icon={<EnvelopeIcon />}>
                  Send
                </Button>
              </Specimen>
              <Specimen name="airmail, waiting" detail="a transaction is out">
                <Button tone="airmail" status="waiting" waitingLabel="Sending…" icon={<EnvelopeIcon />}>
                  Send
                </Button>
              </Specimen>
              <Specimen name="outline" detail="secondary">
                <Button tone="outline" icon={<PasskeyIcon />}>
                  Rotate key
                </Button>
              </Specimen>
              <Specimen name="outline, hover">
                <Button tone="outline" force="hover" icon={<PasskeyIcon />}>
                  Rotate key
                </Button>
              </Specimen>
              <Specimen name="link" detail="navigates">
                <ButtonLink href="/open" icon={<ArrowRightIcon />}>
                  Go to the inbox
                </ButtonLink>
              </Specimen>
            </div>
          </Section>

          <Section id="marks" title="Postmark, strip, stamp" lede="Ink marks struck on the paper. The strip is a postal 4-state bar code of the key fingerprint: 32 bars, two bits each, the same 16 digits as the hex beside it.">
            <div className={styles.row3}>
              <Specimen name="Postmark" detail="ring only">
                <Postmark top="Letterlock register" bottom="Monad testnet" center="1" centerLabel="Epoch" size={128} tilt={-8} />
              </Specimen>
              <Specimen name="Postmark" detail="with cancellation bars">
                <Postmark top="Monad testnet" bottom={postmarkDate(TESTNET_TEST_KEY.updatedAt)} center="1" centerLabel="Epoch" bars="left" size={112} tilt={-6} />
              </Specimen>
              <Specimen name="Wordmark" detail="outlined; “lock” is wax">
                <Wordmark height={48} />
              </Specimen>
            </div>
            <div className={styles.row3}>
              <Specimen name="KeyStrip" detail="open: a key found in the register">
                <div className={styles.stripDemo}>
                  <KeyStrip fingerprint={mayaKey.fingerprint} tone="open" height={22} announce />
                  <code className="data">{groupFingerprint(mayaKey.fingerprint)}</code>
                </div>
              </Specimen>
              <Specimen name="KeyStrip" detail="ink · pencil (superseded)">
                <div className={styles.stripDemo}>
                  <KeyStrip fingerprint={kai.keys[1]!.fingerprint} height={16} announce />
                  <KeyStrip fingerprint={kai.keys[0]!.fingerprint} tone="pencil" height={16} announce />
                </div>
              </Specimen>
              <Specimen name="ExampleBadge" detail="stamped on anything not on chain">
                <ExampleBadge />
              </Specimen>
            </div>
          </Section>

          <Section id="fields" title="Fields" lede="A postal form’s lines: capitals for the label, a ruled box to write in. The note is written on a ruled sheet and counted in bytes, the unit the envelope limit is written in.">
            <div className={styles.row2}>
              <Specimen name="TextField" detail="address, in the data face" plain>
                <TextField label="To" defaultValue={maya.address} data hint="An address (0x…) or an agent (agent:<id>)." />
              </Specimen>
              <Specimen name="TextField" detail="with a form error" plain>
                <TextField label="To" defaultValue="0x4cca…fa30" data error="That is not a whole address: an address is 0x and 40 hex digits." />
              </Specimen>
              <Specimen name="NoteField" detail="bytes counted live" plain wide>
                <NoteField label="Note" defaultValue={note.text} rows={3} />
              </Specimen>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
