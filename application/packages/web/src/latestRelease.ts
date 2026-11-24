import { BETA_CHANGELOG_URL, isBetaHost } from './hosts';
import { siteHref } from './siteLinks';

/** The newest curated release, baked in at build time so the app ships one
 *  entry instead of the whole publicChangelog.ts history. The full history,
 *  with its screenshots, lives on the /changelog page. */
export const LATEST_RELEASE = __PN_LATEST_RELEASE__;

/** The /changelog page. Never a per-release anchor: links point at the page
 *  as a whole, which always opens on the newest release. On the beta site
 *  (including its ?demo=1), stay on beta.privacynotes.app/changelog (GitHub #890). */
export function latestChangelogHref(): string {
  return isBetaHost() ? BETA_CHANGELOG_URL : siteHref('/changelog');
}
