/**
 * Upvotes on each community theme's discussion thread, by thread number.
 * Written by `pnpm theme:votes` (tools/theme-votes.mjs); do not edit by hand.
 * A snapshot, so the app never calls GitHub; on the live site the Worker
 * writes the current counts over the ones /themes was built with
 * (themeVotes.ts). A theme with no row counts as zero. Import-free:
 * themes-page.ts loads this file on its own.
 * Spec: docs/contrib/community-themes.md
 */
export const COMMUNITY_VOTES: Record<number, number> = {
  459: 2,
  460: 4,
  462: 5,
  463: 5,
  464: 6,
  465: 6,
  466: 1,
  467: 5,
  468: 2,
  470: 1,
  474: 1,
  477: 3,
  478: 4,
  479: 2,
  480: 3,
  481: 3,
  482: 3,
  483: 3,
  484: 4,
  485: 5,
  502: 3,
  505: 2,
  506: 2,
  507: 3,
  520: 1,
  573: 2,
  574: 2,
  575: 1,
  576: 1,
  577: 2,
  580: 1,
  581: 1,
  583: 1,
  584: 1,
  585: 2,
  586: 1,
  587: 1,
  588: 2,
  589: 1,
  669: 1,
  670: 1,
  671: 1,
  678: 1,
};
