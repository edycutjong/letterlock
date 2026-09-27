// What the To field of /seal takes: an address, or an ERC-8004 agent. Kept apart from the page so the rule and its
// words are tested (test/recipient.test.ts).

/** An address (0x and 40 hex digits) or an agent (agent: and its id in decimal, with no leading zero). */
export const RECIPIENT = /^(0x[0-9a-fA-F]{40}|agent:(0|[1-9][0-9]{0,77}))$/;

/** The field's error for a recipient that is neither form, naming both, as /open names the address form. */
export const RECIPIENT_FORMS = "An address is 0x and 40 hex digits; an agent is agent: and its number, as in agent:10260.";

/** The error to show for what was typed: none while the field is empty or holds a whole recipient. */
export const recipientError = (typed: string): string | undefined => {
  const t = typed.trim();
  return t && !RECIPIENT.test(t) ? RECIPIENT_FORMS : undefined;
};
