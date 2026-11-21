/**
 * The parts of Firefox's Bergamot glue that the plugin worker uses. The glue
 * is a classic script; the build adds this default export
 * (`pn-bergamot-glue` in vite.config.ts).
 * Spec: docs/internal/specs/plugins-files.md (section 1.3)
 */
type Deletable = { delete(): void };

export type AlignedMemory = Deletable & { size(): number; getByteArrayView(): Uint8Array };

type Vector<T> = Deletable & { size(): number; get(i: number): T; push_back(v: T): void };

export type TranslationModel = Deletable;

type ResponseOptions = { qualityScores: boolean; alignment: boolean; html: boolean };

type BlockingService = Deletable & {
  translate(model: TranslationModel, messages: Vector<string>, options: Vector<ResponseOptions>): Vector<{ getTranslatedText(): string }>;
  translateViaPivoting(first: TranslationModel, second: TranslationModel, messages: Vector<string>, options: Vector<ResponseOptions>): Vector<{ getTranslatedText(): string }>;
};

export type Bergamot = {
  AlignedMemory: new (bytes: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => Vector<AlignedMemory>;
  VectorString: new () => Vector<string>;
  VectorResponseOptions: new () => Vector<ResponseOptions>;
  TranslationModel: new (from: string, to: string, config: string, model: AlignedMemory, lex: AlignedMemory | null, vocabs: Vector<AlignedMemory>, quality: null) => TranslationModel;
  BlockingService: new (options: { cacheSize: number }) => BlockingService;
};

declare function loadBergamot(module: {
  INITIAL_MEMORY: number;
  wasmBinary: Uint8Array;
  print: (s: string) => void;
  printErr: (s: string) => void;
  onAbort: () => void;
  onRuntimeInitialized: () => void;
}): Bergamot;

export default loadBergamot;
