/** The North Star mark: a faceted four-point compass star. Drawn in currentColor. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="7 7 50 50" fill="currentColor" aria-hidden="true">
      <path d="M32 7 26.5 26.5 32 32ZM57 32 37.5 26.5 32 32ZM32 57 37.5 37.5 32 32ZM7 32 26.5 37.5 32 32Z" />
      <path
        opacity=".55"
        d="M32 7 37.5 26.5 32 32ZM57 32 37.5 37.5 32 32ZM32 57 26.5 37.5 32 32ZM7 32 26.5 26.5 32 32Z"
      />
      <circle
        cx="32"
        cy="32"
        r="16"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".35"
        strokeWidth="2.5"
      />
    </svg>
  );
}
