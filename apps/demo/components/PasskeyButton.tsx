import { Button, type ButtonProps } from "./Button";
import { PasskeyIcon } from "./Icons";

export type PasskeyButtonProps = Omit<ButtonProps, "icon" | "tone" | "waitingLabel"> & {
  /** ink by default; airmail when the action opens a letter */
  tone?: "ink" | "airmail";
  waitingLabel?: string;
};

/**
 * The one primary action on a screen that raises a passkey prompt: create an address, open a letter, rotate.
 * While the prompt is up it reads "Waiting for your passkey…" and keeps focus, so the page never looks frozen.
 */
export function PasskeyButton({ tone = "ink", waitingLabel = "Waiting for your passkey…", ...rest }: PasskeyButtonProps) {
  return <Button {...rest} tone={tone} icon={<PasskeyIcon />} waitingLabel={waitingLabel} />;
}
