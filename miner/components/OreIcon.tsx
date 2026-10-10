// The ORE token mark (from ore.com): a thick ring with two diagonal stubs at the
// top-right and bottom-left. Inherits the surrounding text colour via currentColor.
export function OreIcon({ className = "inline size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.8}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <path d="M16.3 7.7 19.7 4.3" />
      <path d="M7.7 16.3 4.3 19.7" />
    </svg>
  );
}
