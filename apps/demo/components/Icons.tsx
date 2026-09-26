// The app's icons, drawn on one 20-unit grid with one 1.6 stroke, round caps and joins, in currentColor.
// Each is decorative: the control or text beside it carries the meaning.
import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

const Icon = ({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {children}
  </svg>
);

/** A passkey: a key whose bow is a fingerprint-like ring. */
export const PasskeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.4" cy="10" r="3.9" />
    <path d="M6.4 8.1a1.9 1.9 0 0 1 0 3.8" />
    <path d="M10.3 10h7.2M14.6 10v2.6M17.1 10v1.8" />
  </Icon>
);

/** Leaves the app: a tx opens on the explorer. */
export const ArrowOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.5 5.5h7v7M14.2 5.8L5.5 14.5" />
  </Icon>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10h11.5M11 5.5l4.5 4.5L11 14.5" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 10.4l3.6 3.6 7.4-8" />
  </Icon>
);

/** Returned to sender: the arrow curls back the way it came. */
export const ReturnIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.5 4.5L3.5 8.5l4 4" />
    <path d="M3.8 8.5h8.7a4.2 4.2 0 0 1 0 8.4H9.5" />
  </Icon>
);

/** Lookup in the register: a reading glass over a ruled line. */
export const LookupIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8.6" cy="8.6" r="4.6" />
    <path d="M12 12l4.5 4.5" />
  </Icon>
);

/** Send: the envelope's flap, pointing down. */
export const EnvelopeIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.8" y="4.8" width="14.4" height="10.4" rx="1" />
    <path d="M3.2 5.4L10 10.6l6.8-5.2" />
  </Icon>
);
