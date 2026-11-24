/**
 * The Swiss flag as an inline SVG, never as the U+1F1E8 U+1F1ED emoji pair:
 * Windows has no flag emoji and draws the pair as the letters CH. (The Linux
 * AppImage crash that first made this an SVG is fixed for every emoji by its
 * bundled emoji font, #863.)
 * Spec: docs/contrib/gotchas.md (Color emoji crash the Linux AppImage)
 */
export function SwissFlag() {
  return (
    <svg
      viewBox="0 0 32 32"
      width="1em"
      height="1em"
      aria-hidden="true"
      className="inline-block shrink-0 align-[-0.125em]"
    >
      <rect width="32" height="32" rx="4" fill="#DA291C" />
      <path fill="#fff" d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" />
    </svg>
  );
}
