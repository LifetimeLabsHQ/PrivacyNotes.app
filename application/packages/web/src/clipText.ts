/**
 * The longest prefix of `s` within `max` UTF-16 units that ends on a
 * character boundary as a person sees one: an emoji, a flag or a family
 * sequence is kept whole or left out, never cut to a lone surrogate. The
 * cap itself stays in UTF-16 units, so nothing stored gets longer.
 */
export function clipGraphemes(s: string, max: number): string {
  if (s.length <= max) return s;
  if (typeof Intl.Segmenter === 'function') {
    let out = '';
    for (const { segment } of new Intl.Segmenter().segment(s)) {
      if (out.length + segment.length > max) break;
      out += segment;
    }
    return out;
  }
  // Without a segmenter (an older Firefox): at least keep a surrogate pair whole.
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
