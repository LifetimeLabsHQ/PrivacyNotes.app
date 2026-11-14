/**
 * Format a byte count as a human-readable string (B / KB / MB / GB) using
 * decimal (SI) units, where 1 KB = 1000 bytes - matching what the OS file
 * browser (macOS Finder, GNOME Files) and cloud storage show. Single source
 * of truth for every size the user sees, so per-file sizes and the storage
 * quota can never drift apart.
 * Spec: docs/internal/design-decisions.md (decimal storage units)
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
}

/** A size string like "42.2 MB" back to bytes, in the same decimal units. */
export function parseSizeToBytes(s: string): number {
  const n = parseFloat(s) || 0;
  if (!n) return 0;
  const lower = s.toLowerCase();
  if (lower.includes('gb')) return n * 1000 * 1000 * 1000;
  if (lower.includes('mb')) return n * 1000 * 1000;
  if (lower.includes('kb')) return n * 1000;
  return n;
}
