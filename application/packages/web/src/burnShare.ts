/**
 * Burn-After-Reading share - encrypts a note's content with a one-time
 * random key, stores the ciphertext server-side in `burn_notes`, and
 * returns a URL with the row ID + decryption key in the fragment.
 *
 * URL format: /burn#id=<uuid>&k=<hex>
 *
 * The key never leaves the client (fragments aren't sent over HTTP).
 * The server only ever sees opaque ciphertext. The row goes through the
 * `burn-create` edge function, which limits each caller address, so one
 * caller cannot use up the ceiling every sender shares; no session is sent,
 * so the row stays anonymous. On reveal, the viewer
 * calls `consume_burn_note(id)` which returns the ciphertext and
 * deletes the row atomically - one read, then it's gone.
 */

import { encryptJson, bytesToHex, bytesToBase64, createSupabaseClient } from '@notes/shared';
import type { LocalNote } from './db';
import { vaultContent, type VaultField } from './vaultFields';
import { linkExportMarkdown } from './linkBody';
import { hasMedia, stripMediaReferences } from './imageProcessing';
import i18n from './i18n';
import { detectPlatform, readFnErrorBody, type FnError } from './devices';
import { isDemoMode } from './demo';
import { APEX_ORIGIN } from './hosts';
import { readLineSpacing } from './theme';

// Lightweight anon client - burn shares don't require auth.
// persistSession: false avoids creating a duplicate GoTrueClient
// instance that shares the same storage key as the main auth client.
const supabase = createSupabaseClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { persistSession: false, storageKey: 'sb-burn-share-auth' },
);

/** Max plaintext bytes before encryption. ~32KB keeps payloads sane. */
const MAX_PAYLOAD_BYTES = 32_768;

export type BurnResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Encrypt the given note content and store the ciphertext on the server.
 * Returns a /burn URL with the row ID and decryption key in the fragment.
 *
 * `fields` carries a vault item's labelled rows. The viewer has no vault code
 * in it - a burn page is what a stranger opens, so it stays small - and a
 * vault body is a JSON blob, which is what the page used to print. The labels
 * therefore travel inside the ciphertext, in the sender's language. A link
 * made before this existed simply arrives without them and renders as before.
 */
export async function createBurnLink(
  title: string,
  body: string,
  fields: VaultField[] | undefined,
  readSeconds: number,
  lifetimeHours: number,
): Promise<BurnResult> {
  // Demo mode makes zero server calls. A burn link is a real row in
  // burn_notes, so the sandbox has to decline rather than write one.
  if (isDemoMode()) {
    return {
      ok: false,
      error: i18n.t('notesChrome:burnShare.demo'),
    };
  }
  // Burn links require a server round-trip - bail early with a friendly
  // message instead of letting the supabase-js call surface a raw
  // "TypeError: Failed to fetch". See gap #30.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      ok: false,
      error: i18n.t('notesChrome:burnShare.offline'),
    };
  }

  // The sender's line spacing and reading time travel along, so the viewer
  // lays the note out the way the sender saw it and clears it when asked.
  const spacing = readLineSpacing();
  const content = fields?.length
    ? { title, body, fields, spacing, readSeconds }
    : { title, body, spacing, readSeconds };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(content));

  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: i18n.t('notesChrome:burnShare.tooLarge', {
        size: Math.round(payloadBytes.length / 1000),
        max: Math.round(MAX_PAYLOAD_BYTES / 1000),
      }),
    };
  }

  // Generate a one-time random 32-byte key via Web Crypto.
  const key = crypto.getRandomValues(new Uint8Array(32));

  // encryptJson produces { ciphertext, nonce } using xchacha20poly1305.
  const { ciphertext, nonce } = encryptJson(content, key);

  // Prepend nonce to ciphertext for self-contained decryption.
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);

  // Store as base64 on the server.
  const ciphertextB64 = bytesToBase64(combined);

  // The id is made here, so the link exists before the server answers and
  // the server never returns a row (burn_notes has no SELECT policy).
  const id = crypto.randomUUID();

  // One call, no retry: a lost answer to a stored row would come back as
  // id_taken. The old direct insert on burn_notes stays open only for builds
  // from before this function, and closes once none of them is supported.
  // Spec: docs/contrib/supabase.md (Burn notes)
  const { error } = await supabase.functions.invoke('burn-create', {
    body: { id, ciphertext: ciphertextB64, lifetime_hours: lifetimeHours },
  });

  if (error) {
    const answer = (await readFnErrorBody(error as FnError)) as { error?: unknown } | null;
    return {
      ok: false,
      error: answer?.error === 'rate_limited'
        ? i18n.t('notesChrome:burnShare.rateLimited')
        : i18n.t('notesChrome:burnShare.storeFailed'),
    };
  }

  const keyHex = bytesToHex(key);
  // Burn links open in the recipient's browser, so the URL must be a public
  // https origin. On native platforms window.location.origin is tauri://localhost
  // (broken once shared), so use the canonical web origin; on web keep the live
  // origin (for local dev) but strip www to avoid a redirect hop.
  // Spec: docs/contrib/gotchas.md (canonical domain privacynotes.app, no www)
  const origin =
    detectPlatform() === 'web'
      ? window.location.origin.replace('://www.', '://')
      : APEX_ORIGIN;
  const url = `${origin}/burn#id=${id}&k=${keyHex}`;

  return { ok: true, url };
}

/**
 * What a note contributes to a burn link: the body the reader sees, plus
 * a vault item's labelled rows. Returns null when the note is media only -
 * images and files never travel, so stripping them leaves nothing to send.
 *
 * Both the burn action and the menu button that offers it read this, so the
 * button can go dim on exactly the notes the action would refuse.
 */
export function prepareBurnPayload(
  note: LocalNote,
): { body: string; stripped: boolean; fields?: VaultField[] } | null {
  // A drawing has no text a burn viewer can show.
  // Spec: docs/internal/specs/drawing.md (section 4, no burn link)
  if (note.type === 'drawing') return null;
  // A vault item's body is the JSON blob its form reads, so send the
  // labelled rows instead and let the item's own notes be the body.
  const vault = vaultContent(note);
  // Bookmarks burn as the bare clickable link, never a fields table.
  let body = linkExportMarkdown(note) ?? (vault ? vault.notes : note.body);
  let stripped = false;
  if (hasMedia(body)) {
    body = stripMediaReferences(body);
    if (!body && !vault) return null;
    stripped = true;
  }
  return { body, stripped, fields: vault?.fields };
}
