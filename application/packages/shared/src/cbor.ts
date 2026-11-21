/**
 * A small CBOR encoder (RFC 8949) for what a WebAuthn authenticator writes:
 * unsigned and negative integers, byte strings, text strings and maps. Every
 * item takes its shortest head; no floats, tags, arrays or indefinite lengths.
 *
 * Map keys go in the CTAP2 canonical order: by the length of the key's
 * encoding, then byte by byte. WebAuthn requires that form for the COSE key
 * and the attestation object. RFC 8949 section 4.2.1 sorts byte by byte only;
 * the two agree for every map an authenticator writes here (all keys of one
 * map encode to the same length or already sort the same way), and differ
 * only for keys of mixed encoded lengths, where CTAP2 wins.
 * Spec: docs/contrib/passkeys.md (section 5.4, Authenticator)
 */

export type CborKey = number | string;
export type CborValue = number | string | Uint8Array | CborMap;
export type CborMap = Map<CborKey, CborValue>;

function head(major: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('cbor: integer out of range');
  const m = major << 5;
  if (value < 24) return Uint8Array.of(m | value);
  if (value < 0x100) return Uint8Array.of(m | 24, value);
  if (value < 0x10000) return Uint8Array.of(m | 25, value >>> 8, value & 0xff);
  if (value < 0x100000000) return Uint8Array.of(m | 26, value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const out = new Uint8Array(9);
  out[0] = m | 27;
  new DataView(out.buffer).setBigUint64(1, BigInt(value));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** CTAP2 canonical order of two encoded keys: shorter first, then byte by byte. */
function keyOrder(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return 0;
}

function parts(value: CborValue): Uint8Array[] {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('cbor: only integers');
    return [value >= 0 ? head(0, value) : head(1, -1 - value)];
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return [head(3, bytes.length), bytes];
  }
  if (value instanceof Uint8Array) return [head(2, value.length), value];
  if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => ({ key: encodeCbor(k), value: encodeCbor(v) }));
    // A Map holds each key once, and two different keys never encode alike.
    entries.sort((a, b) => keyOrder(a.key, b.key));
    return [head(5, entries.length), ...entries.flatMap((e) => [e.key, e.value])];
  }
  throw new Error('cbor: unsupported value');
}

/** The canonical CBOR encoding of `value`. Throws on a value outside the
 *  supported set (a float, an unsafe integer, an array, an object). */
export function encodeCbor(value: CborValue): Uint8Array {
  return concat(parts(value));
}
