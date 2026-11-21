/**
 * Voice to text, the web engine, inside the plugin worker: Whisper small (q8)
 * on onnxruntime-web directly, not transformers.js (plugins-files.md 1.4):
 * the log-mel input, one encoder run per 30-second window, the merged
 * decoder with its cache, greedy search **with timestamp tokens** (without
 * them Whisper stops at a pause and drops most of a German clip,
 * plugins-bench.md 4.1), and the byte-level decode. The audio comes as 16 kHz
 * mono PCM, decoded on the main thread.
 * Spec: docs/internal/plans/plugins.md (section 6.6)
 */
import type * as Ort from 'onnxruntime-web/wasm';
import { applyTimestampRules, cutWindow, joinSegments, logMel, makeDecoder, SAMPLE_RATE, SAMPLES_PER_TIMESTAMP, WINDOW, type Tokens } from './whisper';
import type { Engine } from './pluginWorker';

export type VoiceInput = { pcm: Float32Array; language: string | null };
export type VoiceResult = { text: string; language: string };

// Whisper small: 12 decoder layers, 12 heads of 64.
const LAYERS = 12;
const HEADS = 12;
const HEAD_DIM = 64;
/** The decoder's context, the prompt included. */
const MAX_TOKENS = 448;
/** A window whose first step says "no speech" this surely (in the row after the start token) is skipped: Whisper invents words in silence. */
const NO_SPEECH = 0.6;

type Config = {
  eos_token_id: number;
  no_timestamps_token_id: number;
  decoder_start_token_id: number;
  suppress_tokens: number[];
  begin_suppress_tokens: number[];
  max_initial_timestamp_index?: number;
  lang_to_id: Record<string, number>;
  task_to_id: { transcribe: number };
};

/** The file keys the main thread sends: `encoder`, `decoder`, `vocab`, `config`. */
export async function load(files: Record<string, ArrayBuffer>, ort: typeof Ort): Promise<Engine> {
  const text = new TextDecoder();
  const config = JSON.parse(text.decode(files.config)) as Config;
  const vocab = JSON.parse(text.decode(files.vocab)) as Record<string, number>;
  if (!files.encoder || !files.decoder) throw new Error('not-loaded');
  const options: Ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const encoder = await ort.InferenceSession.create(new Uint8Array(files.encoder), options);
  const decoder = await ort.InferenceSession.create(new Uint8Array(files.decoder), options);
  for (const key of Object.keys(files)) delete files[key];

  const tk: Tokens = {
    eot: config.eos_token_id,
    noTimestamps: config.no_timestamps_token_id,
    timestampBegin: config.no_timestamps_token_id + 1,
    suppress: config.suppress_tokens,
    beginSuppress: config.begin_suppress_tokens,
    maxInitialTimestamp: config.max_initial_timestamp_index ?? 1,
  };
  // <|nospeech|> sits right before <|notimestamps|>.
  const noSpeech = config.no_timestamps_token_id - 1;
  const langIds = new Map(Object.entries(config.lang_to_id).map(([k, v]) => [k.slice(2, -2), v]));
  const decode = makeDecoder(vocab, tk.eot);
  const empty = new ort.Tensor('float32', new Float32Array(0), [1, HEADS, 0, HEAD_DIM]);

  type Cache = Record<string, Ort.Tensor>;
  const step = (ids: number[], hidden: Ort.Tensor, cache: Cache | null) => {
    const feeds: Cache = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (n) => BigInt(n)), [1, ids.length]),
      encoder_hidden_states: hidden,
      use_cache_branch: new ort.Tensor('bool', [cache !== null], [1]),
    };
    for (let i = 0; i < LAYERS; i++) {
      for (const part of ['decoder', 'encoder']) {
        for (const kv of ['key', 'value']) feeds[`past_key_values.${i}.${part}.${kv}`] = cache?.[`${i}.${part}.${kv}`] ?? empty;
      }
    }
    return decoder.run(feeds);
  };
  /** The cache for the next step: this step's decoder part, the first step's encoder part. */
  const nextCache = (out: Cache, encoderPart: Cache | null): Cache => {
    const cache: Cache = {};
    for (let i = 0; i < LAYERS; i++) {
      for (const kv of ['key', 'value']) {
        cache[`${i}.decoder.${kv}`] = out[`present.${i}.decoder.${kv}`]!;
        cache[`${i}.encoder.${kv}`] = encoderPart?.[`${i}.encoder.${kv}`] ?? out[`present.${i}.encoder.${kv}`]!;
      }
    }
    return cache;
  };
  const lastRow = (logits: Ort.Tensor): Float32Array => {
    const [, n, v] = logits.dims as [number, number, number];
    return (logits.data as Float32Array).slice((n - 1) * v, n * v);
  };
  const argmax = (a: Float32Array, from = 0, to = a.length) => {
    let best = from;
    for (let i = from + 1; i < to; i++) if (a[i]! > a[best]!) best = i;
    return best;
  };
  const softmaxAt = (a: Float32Array, i: number) => {
    let max = -Infinity;
    for (const x of a) if (x > max) max = x;
    let sum = 0;
    for (const x of a) sum += Math.exp(x - max);
    return Math.exp(a[i]! - max) / sum;
  };

  return {
    run: async (input, progress) => {
      const { pcm, language } = input as VoiceInput;
      let lang = language && langIds.has(language) ? language : null;
      const segments: { start: number; end: number; text: string }[] = [];
      for (let seek = 0; seek < pcm.length; ) {
        progress(seek, pcm.length);
        const slice = pcm.subarray(seek, Math.min(seek + WINDOW, pcm.length));
        // A tail under a fifth of a second holds no word.
        if (slice.length < SAMPLE_RATE / 5) break;
        const enc = await encoder.run({ input_features: new ort.Tensor('float32', logMel(slice), [1, 80, 3000]) }, ['last_hidden_state']);
        const hidden = enc.last_hidden_state!;
        if (!lang) {
          // "Auto": the language token Whisper finds likeliest after <|startoftranscript|>.
          const first = lastRow((await step([config.decoder_start_token_id], hidden, null)).logits!);
          let best = '';
          for (const [code, id] of langIds) if (!best || first[id]! > first[langIds.get(best)!]!) best = code;
          lang = best;
        }
        const prompt = [config.decoder_start_token_id, langIds.get(lang)!, config.task_to_id.transcribe];
        let out = await step(prompt, hidden, null);
        // "No speech" is what the model says right after <|startoftranscript|>: the first row of this step, not the last (beta #240 item 7).
        const afterStart = (out.logits!.data as Float32Array).subarray(0, out.logits!.dims[2]!);
        if (softmaxAt(afterStart, noSpeech) > NO_SPEECH) {
          seek += slice.length;
          continue;
        }
        const firstLogits = lastRow(out.logits!);
        const encoderPart = nextCache(out, null);
        const generated: number[] = [];
        let logits = firstLogits;
        for (;;) {
          applyTimestampRules(logits, generated, tk);
          const next = argmax(logits);
          if (next === tk.eot) break;
          generated.push(next);
          // A timestamp says how far into the window the words are: the progress inside a window.
          if (next >= tk.timestampBegin) progress(Math.min(seek + (next - tk.timestampBegin) * SAMPLES_PER_TIMESTAMP, pcm.length), pcm.length);
          if (prompt.length + generated.length >= MAX_TOKENS) break;
          out = await step([next], hidden, nextCache(out, encoderPart));
          logits = lastRow(out.logits!);
        }
        const cut = cutWindow(generated, tk, seek / SAMPLE_RATE, slice.length);
        for (const s of cut.segments) segments.push({ start: s.start, end: s.end, text: decode(s.tokens) });
        seek += Math.min(Math.max(cut.advance, SAMPLE_RATE), slice.length);
      }
      progress(pcm.length, pcm.length);
      return { text: joinSegments(segments), language: lang ?? 'en' } satisfies VoiceResult;
    },
    unload: () => {
      void encoder.release();
      void decoder.release();
    },
  };
}
