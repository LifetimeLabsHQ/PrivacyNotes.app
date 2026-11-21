/**
 * Remove noise, the pure half: the model's settings from the ONNX file, the
 * FFT, the short-time transform around the model, and the loudness step.
 * No WebAssembly and no browser API, so tests run it in Node.
 *
 * DPDFNet2 48 kHz takes one spectrum frame at a time (960 samples, a hop of
 * 480, a Vorbis window) with a state that carries over. Its output is two
 * windows late; that delay is cut. The cleaned samples go back into the input
 * array as soon as no later frame reads them, so a 15-minute recording needs
 * one copy of its samples, not two.
 * Spec: docs/internal/specs/plugins-speech-enhancement.md (sections 5, 6 and 8)
 */

/** DPDFNet2 48 kHz takes and gives 48 kHz mono. */
export const CLEANUP_RATE = 48_000;

/** The settings sherpa-onnx wrote into the model's metadata. */
export type DenoiseMeta = {
  nfft: number;
  hop: number;
  windowLength: number;
  stateSize: number;
  /** The first state: the ERB norm, then the spectrum norm at `erbStateSize`. */
  erbInit: number[];
  erbStateSize: number;
  specInit: number[];
};

/** Reads one varint of a protobuf at `at`; returns the value and the next offset. */
function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const x = b[at++];
    if (x === undefined) throw new Error('bad-model');
    v += (x & 0x7f) * mul;
    if (x < 0x80) return [v, at];
    mul *= 128;
  }
}

/**
 * The `metadata_props` of an ONNX model (ModelProto field 14), read from its
 * bytes. Only the top level is walked; the graph is skipped by its length.
 */
export function onnxMetadata(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder();
  const out: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const [key, next] = varint(bytes, at);
    at = next;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      at = varint(bytes, at)[1];
    } else if (wire === 2) {
      const [len, start] = varint(bytes, at);
      at = start + len;
      if (field !== 14) continue;
      // StringStringEntryProto: key 1, value 2.
      let k = '';
      let v = '';
      let p = start;
      while (p < at) {
        const [ek, ep] = varint(bytes, p);
        const [elen, es] = varint(bytes, ep);
        const s = text.decode(bytes.subarray(es, es + elen));
        if (ek >> 3 === 1) k = s;
        else if (ek >> 3 === 2) v = s;
        p = es + elen;
      }
      out[k] = v;
    } else if (wire === 5) {
      at += 4;
    } else if (wire === 1) {
      at += 8;
    } else {
      throw new Error('bad-model');
    }
  }
  return out;
}

export function denoiseMeta(m: Record<string, string>): DenoiseMeta {
  const num = (k: string) => {
    const v = Number(m[k]);
    if (!Number.isFinite(v)) throw new Error('bad-model');
    return v;
  };
  const list = (k: string) => (m[k] ?? '').split(',').map(Number);
  if (m.model_type !== 'dpdfnet' || m.window_type !== 'vorbis') throw new Error('bad-model');
  return {
    nfft: num('n_fft'),
    hop: num('hop_length'),
    windowLength: num('window_length'),
    stateSize: num('state_size'),
    erbInit: list('erb_norm_init'),
    erbStateSize: num('erb_norm_state_size'),
    specInit: list('spec_norm_init'),
  };
}

/** The model's first state. */
export function firstState(meta: DenoiseMeta): Float32Array {
  const s = new Float32Array(meta.stateSize);
  s.set(meta.erbInit);
  s.set(meta.specInit, meta.erbStateSize);
  return s;
}

export const vorbisWindow = (n: number): Float64Array =>
  Float64Array.from({ length: n }, (_, i) => Math.sin((Math.PI / 2) * Math.sin((Math.PI * (i + 0.5)) / n) ** 2));

/** A complex FFT of any length made of the factors 2, 3, 4 and 5 (960 is 4 x 4 x 4 x 3 x 5), with the real-input helpers. */
export function makeFft(n: number) {
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const scratch: [Float64Array, Float64Array][] = [];
  function rec(len: number, ir: Float64Array, ii: Float64Array, off: number, stride: number, or: Float64Array, oi: Float64Array, oo: number, depth: number, sign: number) {
    if (len === 1) {
      or[oo] = ir[off]!;
      oi[oo] = ii[off]!;
      return;
    }
    const r = len % 4 === 0 ? 4 : len % 2 === 0 ? 2 : len % 3 === 0 ? 3 : len % 5 === 0 ? 5 : len;
    const m = len / r;
    for (let q = 0; q < r; q++) rec(m, ir, ii, off + q * stride, stride * r, or, oi, oo + q * m, depth + 1, sign);
    if (!scratch[depth] || scratch[depth]![0].length < len) scratch[depth] = [new Float64Array(len), new Float64Array(len)];
    const [tr, ti] = scratch[depth]!;
    const step = n / len;
    for (let k = 0; k < m; k++) {
      for (let s = 0; s < r; s++) {
        let ar = 0;
        let ai = 0;
        const idx = k + s * m;
        for (let q = 0; q < r; q++) {
          const e = ((q * idx) % len) * step;
          const c = cos[e]!;
          const w = sign * sin[e]!;
          const yr = or[oo + q * m + k]!;
          const yi = oi[oo + q * m + k]!;
          ar += yr * c - yi * w;
          ai += yr * w + yi * c;
        }
        tr[idx] = ar;
        ti[idx] = ai;
      }
    }
    for (let i = 0; i < len; i++) {
      or[oo + i] = tr[i]!;
      oi[oo + i] = ti[i]!;
    }
  }
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  return {
    /** The bins 0 to n/2 of a real signal. */
    rfft(x: Float64Array, re: Float64Array, im: Float64Array) {
      xr.set(x);
      xi.fill(0);
      rec(n, xr, xi, 0, 1, yr, yi, 0, 0, 1);
      for (let k = 0; k <= n / 2; k++) {
        re[k] = yr[k]!;
        im[k] = yi[k]!;
      }
    },
    /** The real signal of the bins 0 to n/2. */
    irfft(re: Float64Array, im: Float64Array, out: Float64Array) {
      for (let k = 0; k <= n / 2; k++) {
        xr[k] = re[k]!;
        xi[k] = im[k]!;
      }
      for (let k = n / 2 + 1; k < n; k++) {
        xr[k] = re[n - k]!;
        xi[k] = -im[n - k]!;
      }
      rec(n, xr, xi, 0, 1, yr, yi, 0, 0, -1);
      for (let i = 0; i < n; i++) out[i] = yr[i]! / n;
    },
  };
}

/** One model call: the spectrum frame in, the cleaned frame back, in place. */
export type FrameFn = (re: Float64Array, im: Float64Array) => Promise<void> | void;

/**
 * Runs the model over the whole recording and writes the result into `x`.
 * Torch's centered STFT with reflect padding; the overlap-add is divided by
 * the summed squared window, then the output moves `delay` samples earlier
 * and the end that has no source is silence. `progress` gets frames done.
 */
export async function denoiseInPlace(x: Float32Array, nfft: number, hop: number, win: Float64Array, delay: number, frame: FrameFn, progress?: (done: number, total: number) => void): Promise<void> {
  const len = x.length;
  if (len === 0) return;
  const pad = nfft / 2;
  const frames = 1 + Math.floor(len / hop);
  const fft = makeFft(nfft);
  const bins = nfft / 2 + 1;
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  const buf = new Float64Array(nfft);
  const out = new Float64Array(nfft);
  const acc = new Float64Array(nfft);
  const norm = new Float64Array(nfft);
  // The padded signal: reflect at both ends.
  const at = (p: number): number => {
    const u = p - pad;
    if (u < 0) return x[Math.min(-u, len - 1)]!;
    if (u >= len) return x[Math.max(2 * (len - 1) - u, 0)]!;
    return x[u]!;
  };
  // Writes padded positions [from, from + count) of the finished overlap-add.
  const emit = (from: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const v = from + i - pad - delay;
      if (v >= 0 && v < len) x[v] = norm[i]! > 1e-8 ? acc[i]! / norm[i]! : 0;
    }
  };
  for (let t = 0; t < frames; t++) {
    const o = t * hop;
    for (let i = 0; i < nfft; i++) buf[i] = at(o + i) * win[i]!;
    fft.rfft(buf, re, im);
    await frame(re, im);
    fft.irfft(re, im, out);
    for (let i = 0; i < nfft; i++) {
      acc[i] = acc[i]! + out[i]! * win[i]!;
      norm[i] = norm[i]! + win[i]! * win[i]!;
    }
    // No later frame reaches [o, o + hop): it is final, and the input
    // there is no longer read (the next frame starts at o + hop - pad).
    emit(o, hop);
    acc.copyWithin(0, hop);
    acc.fill(0, nfft - hop);
    norm.copyWithin(0, hop);
    norm.fill(0, nfft - hop);
    if (progress && t % 200 === 0) progress(t, frames);
  }
  emit(frames * hop, nfft - hop);
  x.fill(0, Math.max(0, len - delay));
  progress?.(frames, frames);
}

/** The peak after the model, about -1 dBFS. */
const PEAK = 0.89;
/** At most 40 dB louder: a recording of near silence stays near silence. */
const MAX_GAIN = 100;

/**
 * One gain for the whole recording, so its peak sits at about -1 dBFS (no
 * compressor). A quiet recording comes out as quiet as it went in without it.
 */
export function normalizePeak(x: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return;
  const gain = Math.min(PEAK / peak, MAX_GAIN);
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * gain;
}

/**
 * The shift of `b` against `a` (0 to `max` samples) where they match best:
 * half a second of `a`, taken where it is loudest, so a quiet start does not
 * decide. 0 when nothing matches.
 */
export function bestLag(a: Float32Array, b: Float32Array, max: number): number {
  const span = 24_000;
  const room = Math.min(a.length, b.length - max) - span;
  if (room < 0) return 0;
  let start = 0;
  let loudest = -1;
  for (let s = 0; s <= room; s += 4_800) {
    let e = 0;
    for (let i = s; i < s + span; i += 8) e += a[i]! * a[i]!;
    if (e > loudest) {
      loudest = e;
      start = s;
    }
  }
  let best = 0;
  let score = 0;
  for (let lag = 0; lag <= max; lag++) {
    let s = 0;
    for (let i = start; i < start + span; i++) s += a[i]! * b[i + lag]!;
    if (s > score) {
      score = s;
      best = lag;
    }
  }
  return best;
}
