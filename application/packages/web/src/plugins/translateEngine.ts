/**
 * Translate notes, the engine inside the plugin worker: Firefox's Bergamot
 * (`bergamot/`), fed the bytes the main thread checked. Every file comes as
 * the `.zst` it was downloaded as; this side unpacks it with fzstd and checks
 * the unpacked bytes against the pin too (plugins.md section 4). A pair with
 * no English side runs through English: de to ja is de to en, then en to ja.
 * Spec: docs/internal/plans/plugins.md (section 6.5), docs/internal/specs/plugins-files.md (section 1.3)
 */
import { decompress } from 'fzstd';
import loadBergamot, { type AlignedMemory, type Bergamot, type TranslationModel } from './bergamot/bergamot-translator.js';
import { sha256Hex } from '../sha256Hex';
import { PLUGIN_FILES } from './files';
import type { Engine } from './pluginWorker';

type Pin = { path: string; rawSha256?: string };

const DIRECTIONS = PLUGIN_FILES.translate.directions as Record<string, readonly Pin[] | undefined>;
const ENGINE: Pin = PLUGIN_FILES.translate.engine[0]!;

/** The byte alignment Marian wants for each kind of file (Firefox's translations-engine.worker.js). */
const ALIGNMENT: Record<string, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

/**
 * Firefox's decoder settings. Every pinned model is an `intgemm.alphas`
 * model, so one precision serves them all.
 */
const CONFIG = `\n${Object.entries({
  'beam-size': '1',
  normalize: '1.0',
  'word-penalty': '0',
  'max-length-break': '128',
  'mini-batch-words': '1024',
  workspace: '128',
  'max-length-factor': '2.0',
  'skip-cost': 'true',
  'cpu-threads': '0',
  quiet: 'true',
  'quiet-translation': 'true',
  'gemm-precision': 'int8shiftAlphaAll',
  alignment: 'soft',
})
  .map(([k, v]) => `            ${k}: ${v}\n`)
  .join('')}            `;

export type TranslateInput = { from: string; to: string; texts: string[]; html: boolean };

/** The unpacked bytes of a pinned `.zst`, only when they match the pin. */
async function unpack(files: Record<string, ArrayBuffer>, pin: Pin): Promise<Uint8Array> {
  const packed = files[pin.path];
  if (!packed || !pin.rawSha256) throw new Error('not-loaded');
  const raw = decompress(new Uint8Array(packed));
  if ((await sha256Hex(raw)) !== pin.rawSha256) throw new Error('bad-file');
  return raw;
}

function start(wasm: Uint8Array): Promise<Bergamot> {
  return new Promise((resolve, reject) => {
    const engine = loadBergamot({
      // Firefox starts at 40 MiB and lets the memory grow.
      INITIAL_MEMORY: 41_943_040,
      wasmBinary: wasm,
      print: () => {},
      printErr: () => {},
      onAbort: () => reject(new Error('engine-failed')),
      onRuntimeInitialized: () => void Promise.resolve().then(() => resolve(engine)),
    });
  });
}

/** The pairs of directions this load holds: every direction whose files all came. */
export async function load(files: Record<string, ArrayBuffer>): Promise<Engine> {
  const bergamot = await start(await unpack(files, ENGINE));
  const models = new Map<string, TranslationModel>();
  const memory: AlignedMemory[] = [];
  for (const [dir, pins] of Object.entries(DIRECTIONS)) {
    if (!pins?.every((p) => files[p.path])) continue;
    const parts: Record<string, AlignedMemory> = {};
    for (const pin of pins) {
      const kind = /^translate\/([a-z]+)-/.exec(pin.path)?.[1] ?? '';
      const align = ALIGNMENT[kind];
      if (!align) throw new Error('bad-file');
      const raw = await unpack(files, pin);
      const mem = new bergamot.AlignedMemory(raw.byteLength, align);
      mem.getByteArrayView().set(raw);
      parts[kind] = mem;
      memory.push(mem);
    }
    const vocabs = new bergamot.AlignedMemoryList();
    if (parts.vocab) vocabs.push_back(parts.vocab);
    else if (parts.srcvocab && parts.trgvocab) {
      vocabs.push_back(parts.srcvocab);
      vocabs.push_back(parts.trgvocab);
    } else throw new Error('bad-file');
    const [src, trg] = dir.startsWith('en-') ? ['en', dir.slice(3)] : [dir.slice(0, -3), 'en'];
    if (!parts.model) throw new Error('bad-file');
    models.set(dir, new bergamot.TranslationModel(src!, trg!, CONFIG, parts.model, parts.lex ?? null, vocabs, null));
  }
  // The packed copies are no longer needed: the engine holds its own.
  for (const key of Object.keys(files)) delete files[key];
  const service = new bergamot.BlockingService({ cacheSize: 0 });

  return {
    run: async (input, progress) => {
      const { from, to, texts, html } = input as TranslateInput;
      const chain = from === 'en' || to === 'en' ? [models.get(`${from}-${to}`)] : [models.get(`${from}-en`), models.get(`en-${to}`)];
      if (chain.some((m) => !m)) throw new Error('not-loaded');
      const messages = new bergamot.VectorString();
      const options = new bergamot.VectorResponseOptions();
      try {
        for (const text of texts) {
          messages.push_back(text);
          options.push_back({ qualityScores: false, alignment: true, html });
        }
        progress(0, 1);
        const out = chain.length === 1 ? service.translate(chain[0]!, messages, options) : service.translateViaPivoting(chain[0]!, chain[1]!, messages, options);
        const result: string[] = [];
        for (let i = 0; i < out.size(); i++) result.push(out.get(i).getTranslatedText());
        out.delete();
        progress(1, 1);
        return result;
      } finally {
        messages.delete();
        options.delete();
      }
    },
    unload: () => {
      service.delete();
      for (const m of models.values()) m.delete();
      for (const m of memory) m.delete();
      models.clear();
    },
  };
}
