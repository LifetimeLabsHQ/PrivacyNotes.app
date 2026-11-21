/**
 * The launch switch of the custom tracker types that need the unknown-type
 * guard: Two numbers (`pair`, GitHub #746) and Counter (`counter`, GitHub
 * #812).
 *
 * A build before TYPE_GUARD_VERSION does not know these types: it draws one
 * as a Yes / No choice, and one tap there replaces the value on every
 * device. From TYPE_GUARD_VERSION on, an unknown type is shown and never
 * written. So the setup offers the types only once no client below that
 * version can write to the server: when the release floor
 * (`minVersion` in packages/desktop/update-policy.json) is at or above it.
 * `tests/customTypesLaunch.test.ts` fails a switch set before that, and
 * `pnpm health` and the floor step of /changelog-publish ask for the flip
 * until it is made. Web builds update themselves and need no wait.
 *
 * A dev build (5173) always offers the types, for review;
 * `import.meta.env.DEV` folds to false in every shipped build. A tracker of
 * these types made in a dev build still works everywhere this version runs.
 * Spec: docs/internal/mood-wellness-tracker.md section 16.1 (launch)
 */
import type { CustomTrackerType } from './trackerTypes';

export const TYPE_GUARD_VERSION = '0.766.0';

export const GUARDED_TYPES_LAUNCHED = false;

/** The types that wait for the switch. */
const GUARDED_TYPES: ReadonlySet<CustomTrackerType> = new Set(['pair', 'counter']);

/** Whether the setup offers the guarded types: after launch, or in a dev build. */
export const GUARDED_TYPES_OFFERED: boolean = GUARDED_TYPES_LAUNCHED || import.meta.env.DEV;

/** Whether the setup offers a type as a chip. */
export function typeOffered(type: CustomTrackerType): boolean {
  return GUARDED_TYPES_OFFERED || !GUARDED_TYPES.has(type);
}
