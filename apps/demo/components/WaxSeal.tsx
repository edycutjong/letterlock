"use client";

import { useEffect, useId, useRef, type CSSProperties } from "react";
import styles from "./WaxSeal.module.css";

/**
 * The wax seal: with the wordmark's "lock", the only thing in the app allowed to be red.
 *
 *   absent → pressing → pressed        seal() completed: the wax drops and presses in with an overshoot (280 ms)
 *   pressed → cracking → cracked       open() succeeded: a crack runs down through the L, the two halves part
 *
 * `pressing` and `cracking` animate INTO `pressed` and `cracked`, so a parent may leave the state on either one.
 * With prefers-reduced-motion the change is instant. Geometry: a 200-unit master (a hand-tuned 13-lobe blob, a
 * raised rim, a debossed Bodoni Moda italic L), lit from the top-left, casting its shadow down-right.
 */
export type WaxSealState = "absent" | "pressing" | "pressed" | "cracking" | "cracked";

export const PRESS_MS = 280;
export const CRACK_MS = 560;

export type WaxSealProps = {
  state: WaxSealState;
  /** Rendered width and height in px. Omit to fill the parent's width. */
  size?: number;
  /** Accessible name. Defaults to a description of the state. */
  label?: string;
  /** Hide from assistive technology when the surrounding text already says whether the letter is sealed. */
  decorative?: boolean;
  /** Fires once when `pressing` or `cracking` has finished moving (at once when motion is reduced). */
  onSettled?: (state: "pressed" | "cracked") => void;
  /** Hold a moving state this many ms into its motion: the /kit filmstrip. */
  freezeAtMs?: number;
  className?: string;
};

const BLOB =
  "M182.2 102.9C183.1 110.1 179.7 112.5 178.2 117.8C176.8 123 176.8 129.5 173.8 134.4C170.7 139.3 163.2 142 159.9 147.5C156.6 152.9 157.9 163.2 154.2 166.9C150.4 170.5 143.4 167.3 137.4 169.3C131.4 171.4 123.9 177.9 118.3 179.4C112.8 180.8 108.7 177.6 104 178C99.2 178.3 94.6 182.8 90 181.4C85.4 180.1 81.7 171.9 76.6 169.6C71.4 167.4 64 170 59.3 167.8C54.5 165.6 52.9 160.6 48 156.3C43.2 152 33.5 148 30 142.1C26.6 136.1 28.7 127 27.3 120.5C26 113.9 22.3 108.3 21.8 102.7C21.3 97.2 23.4 93 24.4 87.2C25.4 81.4 25.3 73.1 27.8 67.9C30.3 62.6 35.3 60.5 39.3 55.9C43.3 51.3 46.8 44.2 51.6 40.2C56.4 36.2 62.7 34.5 67.9 31.9C73 29.4 77.3 25.8 82.7 25.1C88.2 24.3 93.3 27.5 100.5 27.4C107.7 27.4 119 23.3 125.9 24.8C132.7 26.4 135.9 33.1 141.6 36.9C147.3 40.7 154.8 41.6 160 47.9C165.2 54.2 169.1 65.5 172.8 74.7C176.5 83.9 181.3 95.7 182.2 102.9Z";
const MONOGRAM =
  "M55.5 0L-4.9 0L-4.9-2L4.1-2L20.6-73L12.1-73L12.1-75L48.3-75L48.3-73L38.9-73L22.4-2L29.5-2Q37.4-2 42.9-4.5Q48.5-7 52.3-11.6Q56.2-16.2 58.7-22.5L60.7-22.5Z";
/** the crack: an open jagged line from top to bottom, through the stem of the L */
const CRACK =
  "M113 -8L111 12L114 22L108 33L110 43L104 52L106 64L100 71L103 86L96 92L99 104L94 112L98 121L97 131L91 146L95 157L89 169L92 181L88 208";
/** left of the crack line */
const CRACK_A =
  "M-12 -12L113 -8L111 12L114 22L108 33L110 43L104 52L106 64L100 71L103 86L96 92L99 104L94 112L98 121L97 131L91 146L95 157L89 169L92 181L88 208L-12 212Z";
/** right of it, reaching 0.8 past the line so, at rest, its wax covers the seam two abutting clips would leave */
const CRACK_B =
  "M112.2 -8L212 -12L212 212L87.2 208L91.2 181L88.2 169L94.2 157L90.2 146L96.2 131L97.2 121L93.2 112L98.2 104L95.2 92L102.2 86L99.2 71L105.2 64L103.2 52L109.2 43L107.2 33L113.2 22L110.2 12L112.2 -8Z";

const stop = (offset: number, color: string, opacity?: number) => (
  <stop offset={offset} style={{ stopColor: color, ...(opacity === undefined ? {} : { stopOpacity: opacity }) }} />
);

const DEFAULT_LABEL: Record<WaxSealState, string> = {
  absent: "Not sealed yet",
  pressing: "Wax seal, pressed shut",
  pressed: "Wax seal, pressed shut",
  cracking: "Wax seal, broken open",
  cracked: "Wax seal, broken open",
};

export function WaxSeal({ state, size, label, decorative, onSettled, freezeAtMs, className }: WaxSealProps) {
  const uid = `ws${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const ref = (name: string) => `#${id(name)}`;

  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    if ((state !== "pressing" && state !== "cracking") || freezeAtMs !== undefined) return;
    const final = state === "pressing" ? "pressed" : "cracked";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => settled.current?.(final), reduced ? 0 : state === "pressing" ? PRESS_MS : CRACK_MS);
    return () => window.clearTimeout(t);
  }, [state, freezeAtMs]);

  const style = {
    "--press-ms": `${PRESS_MS}ms`,
    "--crack-ms": `${CRACK_MS}ms`,
    ...(freezeAtMs === undefined ? {} : { "--freeze": `${freezeAtMs}ms` }),
  } as CSSProperties;

  /** the cast shadow and the tight contact shadow where the wax meets the paper; one blur, two radii */
  const shadows = (clip?: string) => (
    <>
      <g transform="translate(2.6 4.2)" opacity=".34" filter={url("soft")}>
        <use href={ref("shadow-src")} clipPath={clip} />
      </g>
      <g opacity=".3" transform="translate(.9 1.5) scale(.3)" filter={url("soft")}>
        <use href={ref("shadow-src")} transform="scale(3.3333)" clipPath={clip} />
      </g>
    </>
  );

  return (
    <svg
      className={[styles.seal, className].filter(Boolean).join(" ")}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      overflow="visible"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : (label ?? DEFAULT_LABEL[state])}
      aria-hidden={decorative || undefined}
      focusable="false"
      data-state={state}
      data-frozen={freezeAtMs === undefined ? undefined : ""}
      data-wax=""
      style={style}
    >
      <defs>
        <path id={id("blob")} d={BLOB} />
        <path id={id("L")} transform="translate(77.68 130) scale(.8)" d={MONOGRAM} />
        <path id={id("crack")} d={CRACK} />
        <clipPath id={id("blob-clip")}>
          <use href={ref("blob")} />
        </clipPath>
        <clipPath id={id("L-clip")}>
          <use href={ref("L")} />
        </clipPath>
        <clipPath id={id("crack-a")}>
          <path d={CRACK_A} />
        </clipPath>
        <clipPath id={id("crack-b")}>
          <path d={CRACK_B} />
        </clipPath>

        {/* skirt: the wax slopes down from the rim to the paper */}
        <radialGradient id={id("skirt")} gradientUnits="userSpaceOnUse" cx="100" cy="100" r="86">
          {stop(0.72, "var(--after)")}
          {stop(1, "var(--wax-deep)")}
        </radialGradient>
        {/* key light from the top-left, ink shade to the bottom-right */}
        <linearGradient id={id("light")} x1=".14" y1=".08" x2=".86" y2=".94">
          {stop(0, "var(--wax-sheen)", 0.95)}
          {stop(0.44, "var(--wax-sheen)", 0)}
          {stop(0.58, "var(--ink)", 0)}
          {stop(1, "var(--ink)", 0.3)}
        </linearGradient>
        {/* raised rim, outer slope: faces the light top-left, turns away bottom-right */}
        <linearGradient id={id("rim-out")} x1=".12" y1=".08" x2=".88" y2=".92">
          {stop(0, "var(--wax-sheen)")}
          {stop(0.42, "var(--wax-sheen)")}
          {stop(0.62, "var(--after)")}
          {stop(1, "var(--wax-deep)")}
        </linearGradient>
        <linearGradient id={id("rim-shade")} x1=".12" y1=".08" x2=".88" y2=".92">
          {stop(0.5, "var(--ink)", 0)}
          {stop(1, "var(--ink)", 0.34)}
        </linearGradient>
        {/* raised rim, inner wall down into the pressed face: shaded top-left, lit bottom-right */}
        <linearGradient id={id("rim-in")} x1=".12" y1=".08" x2=".88" y2=".92">
          {stop(0, "var(--wax-deep)")}
          {stop(0.45, "var(--after)")}
          {stop(0.8, "var(--wax-sheen)")}
          {stop(1, "var(--wax-sheen)")}
        </linearGradient>
        <linearGradient id={id("wall-shade")} x1=".12" y1=".08" x2=".88" y2=".92">
          {stop(0, "var(--ink)", 0.38)}
          {stop(0.45, "var(--ink)", 0)}
        </linearGradient>
        <linearGradient id={id("crest")} x1=".1" y1=".1" x2=".8" y2=".85">
          {stop(0, "var(--bg-elevated)", 0.5)}
          {stop(0.42, "var(--bg-elevated)", 0.1)}
          {stop(0.7, "var(--bg-elevated)", 0)}
        </linearGradient>
        {/* pressed face: flat, so only a faint directional wash */}
        <linearGradient id={id("face")} x1=".15" y1=".1" x2=".85" y2=".9">
          {stop(0, "var(--wax-sheen)", 0.38)}
          {stop(0.5, "var(--wax-sheen)", 0)}
          {stop(0.7, "var(--ink)", 0)}
          {stop(1, "var(--ink)", 0.14)}
        </linearGradient>
        {/* radial profiles that round each rim slope into its neighbour (luminance masks) */}
        <radialGradient id={id("prof-out")} gradientUnits="userSpaceOnUse" cx="100" cy="100" r="67">
          {stop(0.86, "var(--bg-elevated)")}
          {stop(1, "var(--bg-elevated)", 0)}
        </radialGradient>
        <radialGradient id={id("prof-in")} gradientUnits="userSpaceOnUse" cx="100" cy="100" r="58.5">
          {stop(0.8, "var(--bg-elevated)", 0)}
          {stop(1, "var(--bg-elevated)")}
        </radialGradient>
        <mask id={id("mask-out")} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <circle cx="100" cy="100" r="67" fill={url("prof-out")} />
        </mask>
        <mask id={id("mask-in")} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <circle cx="100" cy="100" r="58.5" fill={url("prof-in")} />
        </mask>
        <filter id={id("soft")} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>

        <use id={id("shadow-src")} href={ref("blob")} style={{ fill: "var(--ink)" }} />

        <g id={id("body")}>
          <use href={ref("blob")} fill={url("skirt")} />
          <use href={ref("blob")} fill={url("light")} />
          <g clipPath={url("blob-clip")}>
            {/* meniscus: the wax thins and darkens where it meets the paper */}
            <use href={ref("blob")} fill="none" strokeWidth="3.6" strokeOpacity=".7" style={{ stroke: "var(--wax-deep)" }} />
            {/* lit lip on the top-left edge: the outline shifted down-right survives inside only there */}
            <use href={ref("blob")} transform="translate(1.7 2.2)" fill="none" strokeWidth="2.4" style={{ stroke: "var(--wax-sheen)" }} />
          </g>
          <g mask={url("mask-out")}>
            <circle cx="100" cy="100" r="62" fill="none" stroke={url("rim-out")} strokeWidth="9" />
            <circle cx="100" cy="100" r="62" fill="none" stroke={url("rim-shade")} strokeWidth="9" />
          </g>
          <circle cx="100" cy="100" r="53" style={{ fill: "var(--after)" }} />
          <circle cx="100" cy="100" r="53" fill={url("face")} />
          <g mask={url("mask-in")}>
            <circle cx="100" cy="100" r="53" fill="none" stroke={url("rim-in")} strokeWidth="11" />
            <circle cx="100" cy="100" r="53" fill="none" stroke={url("wall-shade")} strokeWidth="11" />
          </g>
          <circle cx="100" cy="100" r="58.5" fill="none" stroke={url("crest")} strokeWidth="1.8" />
          {/* the debossed L: pressed in, not printed on */}
          <use href={ref("L")} x="1.1" y="1.3" style={{ fill: "var(--wax-sheen)" }} />
          <use href={ref("L")} style={{ fill: "var(--wax-deep)" }} />
          <g clipPath={url("L-clip")}>
            <use href={ref("L")} fillOpacity=".45" style={{ fill: "var(--ink)" }} />
            <use href={ref("L")} x="1.1" y="1.3" style={{ fill: "var(--wax-deep)" }} />
          </g>
          {/* glints */}
          <path d="M42.9 81.5A60 60 0 0 1 75.6 45.2" fill="none" strokeOpacity=".26" strokeWidth="1.3" strokeLinecap="round" style={{ stroke: "var(--bg-elevated)" }} />
          <path d="M48 70A60 60 0 0 1 63.1 52.7" fill="none" strokeOpacity=".42" strokeWidth="1.8" strokeLinecap="round" style={{ stroke: "var(--bg-elevated)" }} />
          <ellipse cx="44.8" cy="50.6" rx="5" ry="1.5" transform="rotate(-47 44.8 50.6)" fillOpacity=".24" style={{ fill: "var(--bg-elevated)" }} />
        </g>
      </defs>

      {state === "absent" && (
        <g className={styles.spot}>
          <circle cx="100" cy="100" r="62" />
        </g>
      )}

      {(state === "pressing" || state === "pressed") && (
        <g>
          <circle className={styles.ring} cx="100" cy="102" r="80" />
          <g className={styles.cast}>{shadows()}</g>
          <g className={styles.wax}>
            <use href={ref("body")} />
          </g>
        </g>
      )}

      {(state === "cracking" || state === "cracked") && (
        <g>
          <g className={styles.halfA}>
            {shadows(url("crack-a"))}
            <g clipPath={url("crack-a")}>
              <use href={ref("body")} />
              <use className={styles.lip} href={ref("crack")} clipPath={url("blob-clip")} fill="none" strokeWidth="3" strokeLinejoin="round" style={{ stroke: "var(--wax-deep)" }} />
            </g>
          </g>
          <g className={styles.halfB}>
            {shadows(url("crack-b"))}
            <g clipPath={url("crack-b")}>
              <use href={ref("body")} />
              <use className={styles.lip} href={ref("crack")} clipPath={url("blob-clip")} fill="none" strokeWidth="2.6" strokeLinejoin="round" style={{ stroke: "var(--wax-sheen)" }} />
            </g>
          </g>
          <g clipPath={url("blob-clip")}>
            <path className={styles.crackLine} d={CRACK} pathLength={1} fill="none" strokeWidth="2.4" strokeLinejoin="round" style={{ stroke: "var(--wax-deep)" }} />
          </g>
        </g>
      )}
    </svg>
  );
}
