/**
 * Live upvotes for /themes. The build bakes the counts saved by
 * `pnpm theme:votes` into the page; the Worker reads the current ones from
 * GitHub and writes them over the baked ones as the page goes out. Only the
 * Worker talks to GitHub, with a read-only token, so a visitor never does.
 * At most one GitHub request per edge cache per day, and any failure leaves
 * the baked counts in place.
 * Spec: docs/contrib/community-themes.md
 */

/** The Themes category, so other discussions never push a theme thread out
 *  of the page (GitHub #657). Read once with
 *  `gh api graphql -f query='query{repository(owner:"LifetimeLabsHQ",name:"PrivacyNotes.app"){discussionCategory(slug:"themes"){id}}}'`. */
const THEMES_CATEGORY = 'DIC_kwDOSS8DwM4DHd8x';
/** One page of Themes threads, after `cursor` when given. */
const query = (cursor: string | null) =>
  `query{repository(owner:"LifetimeLabsHQ",name:"PrivacyNotes.app"){discussions(first:100,categoryId:"${THEMES_CATEGORY}"${cursor ? `,after:${JSON.stringify(cursor)}` : ''}){nodes{number upvoteCount category{slug}} pageInfo{hasNextPage endCursor}}}}`;
/** Pages read at most per refresh: 1,000 theme threads. */
const MAX_PAGES = 10;
const CACHE_KEY = 'https://privacynotes.app/_edge/theme-votes?_cv=v1';
const TTL = 24 * 60 * 60;
/** After a failed read, wait this long before this isolate asks GitHub again. */
const RETRY_MS = 10 * 60 * 1000;
let failedAt = 0;

/** Thread number to upvotes, from GitHub's answer; null when it is not one. */
export function parseVotes(body: unknown): Map<number, number> | null {
  const nodes = (body as { data?: { repository?: { discussions?: { nodes?: unknown } } } })?.data?.repository?.discussions?.nodes;
  if (!Array.isArray(nodes)) return null;
  const votes = new Map<number, number>();
  for (const n of nodes as { number?: unknown; upvoteCount?: unknown; category?: { slug?: unknown } }[]) {
    if (n?.category?.slug !== 'themes') continue;
    if (Number.isInteger(n.number) && Number.isInteger(n.upvoteCount) && (n.upvoteCount as number) >= 0) {
      votes.set(n.number as number, n.upvoteCount as number);
    }
  }
  return votes;
}

/** The page's own list, newest first: "474:2,470:2" (thread:baked votes). */
export function parseShipped(content: string): { thread: number; votes: number }[] {
  return content
    .split(',')
    .map((pair) => pair.split(':').map(Number))
    .filter(([t, v]) => Number.isInteger(t) && t! > 0 && Number.isInteger(v) && v! >= 0)
    .map(([thread, votes]) => ({ thread: thread!, votes: votes! }));
}

/** Each thread's count and its place by votes (`ov`), a tie going to the newer. */
export function rankThemes(
  shipped: { thread: number; votes: number }[],
  live: Map<number, number>,
): Map<number, { votes: number; ov: number }> {
  const counted = shipped.map((s, newest) => ({ thread: s.thread, newest, votes: live.get(s.thread) ?? s.votes }));
  counted.sort((a, b) => b.votes - a.votes || a.newest - b.newest);
  return new Map(counted.map((c, ov) => [c.thread, { votes: c.votes, ov }]));
}

/** The current upvotes, from the edge cache or GitHub; null when neither answers. */
export async function liveVotes(
  token: string | undefined,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Map<number, number> | null> {
  if (!token) return null;
  const cache = caches.default;
  const key = new Request(CACHE_KEY);
  try {
    const cached = await cache.match(key);
    if (cached) return parseVotes(await cached.json());
  } catch {
    // A broken cache entry is a miss.
  }
  if (Date.now() - failedAt < RETRY_MS) return null;
  try {
    // Every page of the category, joined into one answer of the shape a
    // single page has, so the cache and parseVotes read it as before.
    const nodes: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'PrivacyNotes-Theme-Votes/1.0',
        },
        body: JSON.stringify({ query: query(cursor) }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const answer = (await res.json()) as { data?: { repository?: { discussions?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } } };
      const found = answer?.data?.repository?.discussions;
      if (!Array.isArray(found?.nodes)) throw new Error('shape');
      nodes.push(...found.nodes);
      const next = found.pageInfo?.hasNextPage === true && typeof found.pageInfo.endCursor === 'string' ? found.pageInfo.endCursor : null;
      if (!next) break;
      cursor = next;
    }
    const body = { data: { repository: { discussions: { nodes } } } };
    const votes = parseVotes(body);
    if (!votes) throw new Error('shape');
    ctx.waitUntil(
      cache.put(
        key,
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL}` },
        }),
      ),
    );
    return votes;
  } catch (err) {
    console.error(`theme-votes: ${err instanceof Error ? err.message : 'error'}`);
    failedAt = Date.now();
    return null;
  }
}
