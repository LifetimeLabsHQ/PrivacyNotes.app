import type { SupabaseClient } from '@notes/shared';

/**
 * The session token a signed-in web app sends with a download through the
 * Worker (`clipDownload.ts`). Null outside a session. A leaf of its own, so
 * a caller on the boot path (NotesView, useClipper) does not pull the
 * download code in with it.
 */
export type TokenSource = () => Promise<string | null>;

/** The token source of a client: its current session's access token. */
export function sessionTokenOf(supabase: SupabaseClient): TokenSource {
  return async () => (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
