/** Escape text for HTML element content and for a double-quoted attribute
 *  value: `&`, `<`, `>` and `"`. The quote matters wherever the value lands
 *  in an attribute, such as an imported link's href: a URL that passes the
 *  scheme test but carries a quote would otherwise break out of it. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
