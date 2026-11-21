/**
 * The parts of Whisper that are plain arithmetic, shared by the voice engine
 * in the plugin worker and its tests: the log-mel input, the timestamp rules
 * of the decoder loop, where a window ends, and the byte-level decode of the
 * vocabulary. No onnxruntime here.
 * Spec: docs/internal/plans/plugins.md (section 6.6), docs/internal/specs/plugins-files.md (section 1.4)
 */

// Spec: docs/internal/specs/plugins-files.md (section 1.4): preprocessor_config.json of whisper-small
export const SAMPLE_RATE = 16_000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const BINS = N_FFT / 2 + 1;
/** One window: 30 seconds, 3000 frames. */
export const WINDOW = 30 * SAMPLE_RATE;
const FRAMES = WINDOW / HOP;
/** A timestamp token is 0.02 s: two frames. */
export const SAMPLES_PER_TIMESTAMP = 2 * HOP;

/** The Slaney mel scale (librosa's default, and Whisper's). */
function hzToMel(f: number): number {
  return f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27);
}
function melToHz(m: number): number {
  return m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));
}

let filters: Float32Array | null = null;
let cos: Float32Array | null = null;
let sin: Float32Array | null = null;
let hann: Float32Array | null = null;

function tables() {
  if (filters && cos && sin && hann) return { filters, cos, sin, hann };
  // 80 triangles over 0 to 8000 Hz, Slaney-normalized.
  const f = new Float32Array(N_MELS * BINS);
  const top = hzToMel(SAMPLE_RATE / 2);
  const pts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz((top * i) / (N_MELS + 1)));
  for (let m = 0; m < N_MELS; m++) {
    const [lo, mid, hi] = [pts[m]!, pts[m + 1]!, pts[m + 2]!];
    const norm = 2 / (hi - lo);
    for (let k = 0; k < BINS; k++) {
      const hz = (k * SAMPLE_RATE) / N_FFT;
      f[m * BINS + k] = Math.max(0, Math.min((hz - lo) / (mid - lo), (hi - hz) / (hi - mid))) * norm;
    }
  }
  const c = new Float32Array(BINS * N_FFT);
  const s = new Float32Array(BINS * N_FFT);
  for (let k = 0; k < BINS; k++) {
    for (let n = 0; n < N_FFT; n++) {
      c[k * N_FFT + n] = Math.cos((2 * Math.PI * k * n) / N_FFT);
      s[k * N_FFT + n] = Math.sin((2 * Math.PI * k * n) / N_FFT);
    }
  }
  const h = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) h[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  filters = f;
  cos = c;
  sin = s;
  hann = h;
  return { filters: f, cos: c, sin: s, hann: h };
}

/**
 * Whisper's input for one 30-second window: 80 log-mel bins by 3000 frames,
 * as `WhisperFeatureExtractor` makes it (centered STFT with reflect padding,
 * a periodic Hann window, power spectrum, the last frame dropped, log10,
 * clamped 8 below the peak, scaled to about -1 to 1). Shorter audio is
 * padded with silence.
 */
export function logMel(audio: Float32Array): Float32Array {
  const { filters: fb, cos: c, sin: s, hann: h } = tables();
  const pcm = new Float32Array(WINDOW);
  pcm.set(audio.subarray(0, WINDOW));
  const half = N_FFT / 2;
  const at = (i: number) => pcm[i < 0 ? -i : i >= WINDOW ? 2 * (WINDOW - 1) - i : i]!;
  const out = new Float32Array(N_MELS * FRAMES);
  const frame = new Float32Array(N_FFT);
  const power = new Float32Array(BINS);
  let peak = -Infinity;
  for (let t = 0; t < FRAMES; t++) {
    const start = t * HOP - half;
    for (let n = 0; n < N_FFT; n++) frame[n] = at(start + n) * h[n]!;
    for (let k = 0; k < BINS; k++) {
      let re = 0;
      let im = 0;
      const row = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n]! * c[row + n]!;
        im -= frame[n]! * s[row + n]!;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      let v = 0;
      const row = m * BINS;
      for (let k = 0; k < BINS; k++) v += fb[row + k]! * power[k]!;
      const log = Math.log10(Math.max(v, 1e-10));
      out[m * FRAMES + t] = log;
      if (log > peak) peak = log;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, peak - 8) + 4) / 4;
  return out;
}

/** The token numbers of the decoder loop, from generation_config.json. */
export type Tokens = {
  eot: number;
  noTimestamps: number;
  /** The first timestamp token, <|0.00|>. */
  timestampBegin: number;
  suppress: readonly number[];
  beginSuppress: readonly number[];
  maxInitialTimestamp: number;
};

/**
 * The rules Whisper's timestamps follow, applied to one step's logits in
 * place (transformers' `WhisperTimeStampLogitsProcessor`): the first token is
 * a timestamp near the start; timestamps come in pairs and never go back; when
 * the timestamps together are likelier than any word, a timestamp it is.
 */
export function applyTimestampRules(logits: Float32Array, generated: readonly number[], tk: Tokens): void {
  const NEG = -Infinity;
  for (const t of tk.suppress) logits[t] = NEG;
  logits[tk.noTimestamps] = NEG;
  const tsBegin = tk.timestampBegin;
  if (generated.length === 0) {
    for (const t of tk.beginSuppress) logits[t] = NEG;
    for (let i = 0; i < tsBegin; i++) logits[i] = NEG;
    for (let i = tsBegin + tk.maxInitialTimestamp + 1; i < logits.length; i++) logits[i] = NEG;
    return;
  }
  const last = generated.at(-1)!;
  const lastWasTs = last >= tsBegin;
  const penultimateWasTs = generated.length < 2 || generated.at(-2)! >= tsBegin;
  if (lastWasTs) {
    if (penultimateWasTs) for (let i = tsBegin; i < logits.length; i++) logits[i] = NEG;
    else for (let i = 0; i < tk.eot; i++) logits[i] = NEG;
  }
  let lastTs = -1;
  for (let i = generated.length - 1; i >= 0; i--) {
    if (generated[i]! >= tsBegin) {
      lastTs = generated[i]!;
      break;
    }
  }
  if (lastTs >= 0) {
    const stop = lastWasTs && !penultimateWasTs ? lastTs : lastTs + 1;
    for (let i = tsBegin; i < stop; i++) logits[i] = NEG;
  }
  // Log-softmax: the timestamps' total against the best word.
  let max = NEG;
  for (let i = 0; i < logits.length; i++) if (logits[i]! > max) max = logits[i]!;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i]! - max);
  const lse = max + Math.log(sum);
  let tsSum = 0;
  let tsMax = NEG;
  for (let i = tsBegin; i < logits.length; i++) if (logits[i]! > tsMax) tsMax = logits[i]!;
  if (tsMax > NEG) for (let i = tsBegin; i < logits.length; i++) tsSum += Math.exp(logits[i]! - tsMax);
  const tsLogprob = tsMax > NEG ? tsMax + Math.log(tsSum) - lse : NEG;
  let textMax = NEG;
  for (let i = 0; i < tsBegin; i++) if (logits[i]! > textMax) textMax = logits[i]!;
  if (tsLogprob > textMax - lse) for (let i = 0; i < tsBegin; i++) logits[i] = NEG;
}

export type Segment = { start: number; end: number; tokens: number[] };

/**
 * What one window said, as segments in seconds from `offset`, and how far the
 * audio is read: a window that ends inside a sentence is read again from the
 * end of its last whole segment (OpenAI's `transcribe`).
 */
export function cutWindow(generated: readonly number[], tk: Tokens, offset: number, windowSamples: number): { segments: Segment[]; advance: number } {
  const tsBegin = tk.timestampBegin;
  const toks = generated.filter((t) => t !== tk.eot);
  const isTs = toks.map((t) => t >= tsBegin);
  const single = isTs.length >= 2 && !isTs.at(-2) && isTs.at(-1)!;
  const pairs: number[] = [];
  for (let i = 1; i < toks.length; i++) if (isTs[i - 1] && isTs[i]) pairs.push(i);
  const time = (t: number) => offset + ((t - tsBegin) * SAMPLES_PER_TIMESTAMP) / SAMPLE_RATE;
  if (pairs.length === 0) {
    const ts = toks.filter((t) => t >= tsBegin);
    const text = toks.filter((t) => t < tk.eot);
    const end = ts.length ? time(ts.at(-1)!) : offset + windowSamples / SAMPLE_RATE;
    return { segments: text.length ? [{ start: ts.length ? time(ts[0]!) : offset, end, tokens: text }] : [], advance: windowSamples };
  }
  const ends = single ? [...pairs, toks.length] : pairs;
  const segments: Segment[] = [];
  let from = 0;
  for (const end of ends) {
    const part = toks.slice(from, end);
    const text = part.filter((t) => t < tk.eot);
    if (text.length) segments.push({ start: time(part[0]!), end: time(part.at(-1)!), tokens: text });
    from = end;
  }
  if (single) return { segments, advance: windowSamples };
  const lastTs = toks[pairs.at(-1)! - 1]! - tsBegin;
  const advance = lastTs * SAMPLES_PER_TIMESTAMP;
  return { segments, advance: advance > 0 ? advance : windowSamples };
}

/** GPT-2's byte to letter table, which the vocabulary's strings are written in. */
function byteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  return new Map(cs.map((c, i) => [String.fromCodePoint(c), bs[i]!]));
}

/** The text of token numbers: only ids under `eot` are words; the rest are control tokens. */
export function makeDecoder(vocab: Record<string, number>, eot: number): (ids: readonly number[]) => string {
  const byId = new Map<number, string>();
  for (const [token, id] of Object.entries(vocab)) byId.set(id, token);
  const bytes = byteDecoder();
  const utf8 = new TextDecoder('utf-8');
  return (ids) => {
    const out: number[] = [];
    for (const id of ids) {
      if (id >= eot) continue;
      for (const ch of byId.get(id) ?? '') {
        const b = bytes.get(ch);
        if (b !== undefined) out.push(b);
      }
    }
    return utf8.decode(new Uint8Array(out));
  };
}

/** The transcript: one paragraph per run of speech, a new one after a pause of two seconds or more. */
export function joinSegments(segments: readonly { start: number; end: number; text: string }[]): string {
  const paras: string[] = [];
  let cur = '';
  let lastEnd = -Infinity;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    if (cur && s.start - lastEnd >= 2) {
      paras.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${text}` : text;
    lastEnd = s.end;
  }
  if (cur) paras.push(cur);
  return paras.join('\n');
}
