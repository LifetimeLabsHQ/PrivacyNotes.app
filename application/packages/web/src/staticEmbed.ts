/**
 * A static embedding model on this device (Model2Vec style): a WordPiece
 * tokenizer, one stored vector per token, and their mean. No model runtime,
 * no network: the caller hands in the model's two files, which the user chose
 * to download (Settings > Offline AI).
 *
 * The file format is ours, made by `tools/embed-model/convert.mjs` from the
 * published model: `vocab.txt` (one token per line, in id order) and
 * `vectors.bin`:
 *
 *   bytes 0-3   magic "PNEV"
 *   bytes 4-7   uint32 rows (little-endian)
 *   bytes 8-11  uint32 dims
 *   then        float32[rows] one scale per row
 *   then        int8[rows * dims] the table, row by row
 *
 * A row's value is int8 * scale. int8 keeps cosine within 0.0001 of the
 * float table (measured on both models, `tools/embed-model/bakeoff.mjs`).
 *
 * The tokenizer is the BERT one both chosen models use: clean the text, put
 * spaces around Han characters, lowercase, strip accents, split on spaces and
 * punctuation, then greedy longest-match WordPiece with "##" pieces. Unknown
 * words are dropped, as Model2Vec drops them.
 *
 * Spec: docs/internal/plans/related-notes.md (section 4a)
 */

export type StaticModel = {
  dims: number;
  /** The unit-length meaning vector of a text, or null when no token is known. */
  embed: (text: string) => Float32Array | null;
};

const MAGIC = 0x56454e50; // "PNEV" read little-endian
const MAX_WORD_CHARS = 100;
/** Model2Vec reads a text only this far; a longer note is judged by its start. */
const MAX_TOKENS = 512;

/** Han ideographs, the ranges BERT's `_is_chinese_char` names. Kana, Hangul and Thai are not in it. */
const HAN = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{2f800}-\u{2fa1f}]/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const PUNCT = /[\p{P}!-/:-@[-`{-~]/u;

/** BertNormalizer and BertPreTokenizer: the words a text splits into. */
function bertWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  const flush = () => {
    if (word) words.push(word);
    word = '';
  };
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  for (const ch of normalized) {
    if (ch === '\u0000' || ch === '�') continue;
    if (/\s/u.test(ch)) {
      flush();
      continue;
    }
    if (CONTROL.test(ch)) continue;
    if (HAN.test(ch) || PUNCT.test(ch)) {
      flush();
      words.push(ch);
      continue;
    }
    word += ch;
  }
  flush();
  return words;
}

/** WordPiece over one word: the ids of its pieces, or none when a piece is missing. */
function wordPieces(word: string, vocab: ReadonlyMap<string, number>, out: number[]): void {
  const chars = [...word];
  if (chars.length > MAX_WORD_CHARS) return;
  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found = -1;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
      const id = vocab.get(piece);
      if (id !== undefined) {
        found = id;
        break;
      }
      end -= 1;
    }
    if (found < 0) return; // the whole word is unknown
    ids.push(found);
    start = end;
  }
  out.push(...ids);
}

/** The token ids of a text, without special tokens, unknown words left out. */
function tokenIds(text: string, vocab: ReadonlyMap<string, number>): number[] {
  const ids: number[] = [];
  for (const word of bertWords(text)) {
    wordPieces(word, vocab, ids);
    if (ids.length >= MAX_TOKENS) return ids.slice(0, MAX_TOKENS);
  }
  return ids;
}

/** Reads the two model files. Throws on a file that is not ours. */
export function loadStaticModel(vocabText: string, vectors: ArrayBuffer): StaticModel {
  const head = new DataView(vectors, 0, 12);
  if (head.getUint32(0, true) !== MAGIC) throw new Error('static model: bad magic');
  const rows = head.getUint32(4, true);
  const dims = head.getUint32(8, true);
  if (vectors.byteLength !== 12 + rows * 4 + rows * dims) throw new Error('static model: bad size');
  const scales = new Float32Array(vectors.slice(12, 12 + rows * 4));
  const table = new Int8Array(vectors, 12 + rows * 4, rows * dims);
  const tokens = vocabText.split('\n');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length !== rows) throw new Error('static model: vocab and table differ');
  const vocab = new Map<string, number>();
  tokens.forEach((t, i) => vocab.set(t, i));

  const embed = (text: string): Float32Array | null => {
    const ids = tokenIds(text, vocab);
    if (ids.length === 0) return null;
    const sum = new Float32Array(dims);
    for (const id of ids) {
      const scale = scales[id]!;
      const offset = id * dims;
      for (let d = 0; d < dims; d++) sum[d]! += table[offset + d]! * scale;
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += sum[d]! * sum[d]!;
    norm = Math.sqrt(norm);
    if (norm === 0) return null;
    for (let d = 0; d < dims; d++) sum[d]! /= norm;
    return sum;
  };
  return { dims, embed };
}
