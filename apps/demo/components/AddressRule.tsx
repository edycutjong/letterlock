/**
 * The swelled rule an address is written on: thick in the middle, thin at the ends, each end curled into a ball
 * terminal, like the line under an engraved address. It scales with its width, so it never distorts.
 */
export function AddressRule({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 340 20" fill="currentColor" aria-hidden="true" focusable="false" preserveAspectRatio="xMinYMid meet">
      <path d="M12 9.1Q170 5.6 328 9.1L328 10.1Q170 13.6 12 10.1Z" />
      <path d="M13.2 9.3C7.4 9.3 4.4 10.9 4.1 13.6L5.6 13.7C5.8 11.6 8.3 10.3 13.2 10.2Z" />
      <path d="M326.8 9.9C332.6 9.9 335.6 8.3 335.9 5.6L334.4 5.5C334.2 7.6 331.7 8.9 326.8 9Z" />
      <circle cx="4.9" cy="15" r="2.5" />
      <circle cx="335.1" cy="4.2" r="2.5" />
    </svg>
  );
}
