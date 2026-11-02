/**
 * Central pricing constants.
 * Update HERE when prices change - all UI references import from this file.
 *
 * Server-side mirrors (require manual migration / edge-function redeploy):
 *   - quota_limits_for_pubkey(): 50 MB free / 500 MB Pro (schema.sql)
 *   - admin_dashboard_overview(): early_supporters < threshold, remaining = limit - count
 *   - paddle-webhook/index.ts: ?? PRO_PRICE_CENTS fallback
 */

export const PRO_PRICE = 89;
export const EARLY_PRICE = 48;
export const EARLY_SUPPORTER_LIMIT = 480;
export const STORAGE_ADDON_PRICE = 4.80;   // per GB per year (base / 1 GB)

/**
 * Storage add-on packages. Pro-only, recurring yearly, additive to the
 * 500 MB Pro base. Bigger packages carry a built-in volume discount.
 * Spec: docs/internal/design-decisions.md (storage add-on packages)
 */
export type StoragePackage = { gb: number; pricePerYear: number };
export const STORAGE_PACKAGES: StoragePackage[] = [
  { gb: 1, pricePerYear: 4.80 },  // $4.80/GB
  { gb: 2, pricePerYear: 8.40 },  // $4.20/GB (~12% off)
  { gb: 5, pricePerYear: 18.00 }, // $3.60/GB (25% off)
];

/**
 * The yearly fees the upgrade modal charts against the one-time price, over
 * COMPARE_YEARS. Web and desktop only: a store build shows its own localized
 * price and has nothing in USD to chart against it.
 * Spec: docs/internal/design-decisions.md (Pro anchored against subscription competitors)
 */
export const COMPARE_YEARS = 5;
export const COMPETITOR_YEARLY = [
  { name: 'Obsidian Sync', perYear: 48 },
  { name: 'Standard Notes', perYear: 90 },
] as const;

/**
 * The apps the homepage price calculator offers, by the pillar or feature
 * of ours each one stands in for: popular apps sold as a subscription only
 * (no one-time purchases, nothing under about $25 a year). `perYear` is the
 * USD price for one person on annual billing; `on` ticks it at the start, one
 * typical app per group at most (the calculator allows one per group). Read from each app's pricing page (or a
 * dated snapshot of it) on STACK_CHECKED; where sources disagree, the lower
 * regular price, never a first-year promo. Prices move, so re-check them
 * before a release that shows this list. Brand names, not translated.
 * Spec: docs/internal/design/patterns/151-160.md section 154
 */
export const STACK_CHECKED = '2026-10-24';
export type StackApp = { name: string; perYear: number; on: boolean };
export const STACK_GROUPS: readonly { key: string; apps: readonly StackApp[] }[] = [
  { key: 'notes', apps: [
    { name: 'Notion Plus', perYear: 120, on: true },
    { name: 'Evernote', perYear: 99, on: false },
    { name: 'Standard Notes', perYear: 90, on: false },
    { name: 'Obsidian Sync', perYear: 48, on: false },
    { name: 'Bear Pro', perYear: 29.99, on: false },
  ] },
  { key: 'tasks', apps: [
    { name: 'Todoist Pro', perYear: 60, on: true },
    { name: 'TickTick', perYear: 35.99, on: false },
  ] },
  { key: 'passwords', apps: [
    { name: '1Password', perYear: 47.88, on: true },
    { name: 'Dashlane', perYear: 59.88, on: false },
    { name: 'Keeper', perYear: 34.99, on: false },
  ] },
  { key: 'journal', apps: [
    { name: 'Day One', perYear: 49.99, on: true },
  ] },
  { key: 'mood', apps: [
    { name: 'Daylio', perYear: 35.99, on: true },
    { name: 'Bearable', perYear: 34.99, on: false },
  ] },
  { key: 'medication', apps: [
    { name: 'Medisafe', perYear: 39.99, on: false },
  ] },
  { key: 'files', apps: [
    { name: 'Dropbox Plus', perYear: 119.88, on: true },
    { name: 'Google One 2 TB', perYear: 99.99, on: false },
    { name: 'iCloud+ 200 GB', perYear: 35.88, on: false },
  ] },
  { key: 'calendar', apps: [
    { name: 'Fantastical', perYear: 56.99, on: true },
  ] },
  { key: 'bookmarks', apps: [
    { name: 'Readwise Reader', perYear: 119.88, on: false },
    { name: 'Instapaper', perYear: 59.99, on: false },
    { name: 'Raindrop.io Pro', perYear: 28, on: false },
  ] },
];

/** Pro full price in cents - used to detect early supporters (amount_cents < this). */
// Spec: docs/internal/design-decisions.md (Pro full price = $89 = 8900 cents)
export const PRO_PRICE_CENTS = PRO_PRICE * 100;
