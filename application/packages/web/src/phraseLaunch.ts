/**
 * The launch switch of the phrase change and the 24-word choice. Both go
 * live on one day (D1): step 8 sets PHRASE_CHANGE_LAUNCHED to true in the
 * release that opens the server allowlist to every managed account.
 *
 * Before launch, the parts with no server gate show only in a dev build, for
 * review: the 24-word choice in onboarding and in the OAuth sign-up, and the
 * Phrase tab's tiles in the demo (try.privacynotes.app is public).
 * `import.meta.env.DEV` folds to false in every shipped build. The Phrase
 * tab of a real account needs no switch: it shows only when `rotate-phrase`
 * answers `allowed`, which the allowlist decides.
 * Spec: docs/internal/plans/phrase-change.md (section 13, steps 7 and 8)
 */
const PHRASE_CHANGE_LAUNCHED = false;

/** Whether the parts with no server gate show: after launch, or in a dev build. */
export const PHRASE_CHANGE_PREVIEW: boolean = PHRASE_CHANGE_LAUNCHED || import.meta.env.DEV;
