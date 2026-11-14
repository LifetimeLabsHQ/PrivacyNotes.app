/**
 * The launch switch of the Two numbers custom tracker type (`pair`, GitHub
 * #746).
 *
 * A build before PAIR_GUARD_VERSION does not know the type: it draws a pair
 * as a Yes / No choice, and one tap there replaces the reading on every
 * device. From PAIR_GUARD_VERSION on, an unknown type is shown and never
 * written. So the setup offers the type only once no client below that
 * version can write to the server: when the release floor
 * (`minVersion` in packages/desktop/update-policy.json) is at or above it.
 * `tests/pairTrackerLaunch.test.ts` fails a switch set before that, and
 * `pnpm health` and the floor step of /changelog-publish ask for the flip
 * until it is made. Web builds update themselves and need no wait.
 *
 * A dev build (5173) always offers the type, for review; `import.meta.env.DEV`
 * folds to false in every shipped build. A pair tracker made in a dev build
 * still works everywhere this version runs.
 * Spec: docs/internal/mood-wellness-tracker.md section 16.1 (launch)
 */
export const PAIR_GUARD_VERSION = '0.766.0';

export const PAIR_TRACKER_LAUNCHED = false;

/** Whether the setup offers the Two numbers type: after launch, or in a dev build. */
export const PAIR_TRACKER_OFFERED: boolean = PAIR_TRACKER_LAUNCHED || import.meta.env.DEV;
