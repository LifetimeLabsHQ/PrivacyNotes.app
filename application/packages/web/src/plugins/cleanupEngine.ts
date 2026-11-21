/// <reference lib="webworker" />
import type * as Ort from 'onnxruntime-web/wasm';
import type { Engine } from './pluginWorker';
import { aacConfig, muxM4a, muxOgg } from './audioMux';
import { bestLag, CLEANUP_RATE as SAMPLE_RATE, denoiseInPlace, denoiseMeta, firstState, normalizePeak, onnxMetadata, vorbisWindow } from './cleanupDsp';

/**
 * Remove noise in the plugin worker: DPDFNet2 48 kHz on onnxruntime, one
 * frame a call, then one gain for the whole file, then WebCodecs
 * `AudioEncoder` (AAC where it exists, else Opus) and our muxer. The audio
 * comes in as 48 kHz mono PCM and goes out as a file; nothing is stored here.
 * Spec: docs/internal/specs/plugins-speech-enhancement.md (sections 5 and 8)
 */

export type CleanupInput = { pcm: Float32Array };
export type CleanupResult = { data: Uint8Array; mime: 'audio/mp4' | 'audio/ogg' };

const AAC = { codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 64_000 };
const OPUS = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32_000 };
/** The most priming an AAC encoder adds that we look for: 4096 samples, 85 ms. */
const MAX_PRIMING = 4096;
/** Samples per AudioData handed to the encoder: one second. */
const CHUNK = SAMPLE_RATE;

/**
 * How many samples the AAC encoder put before the audio (2112 on Apple's,
 * other encoders differ): the first three seconds of the file decoded again
 * and matched against the input. 0 when the platform has no decoder.
 */
async function primingOf(packets: readonly Uint8Array[], description: Uint8Array, pcm: Float32Array): Promise<number> {
  if (typeof AudioDecoder === 'undefined') return 0;
  const decoded: Float32Array[] = [];
  const decoder = new AudioDecoder({
    output: (data) => {
      const out = new Float32Array(data.numberOfFrames);
      data.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(out);
      data.close();
    },
    error: () => {},
  });
  try {
    decoder.configure({ ...AAC, description });
    const n = Math.min(packets.length, 150);
    for (let i = 0; i < n; i++) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(((i * 1024) / SAMPLE_RATE) * 1e6), data: packets[i]! }));
    await decoder.flush();
  } catch {
    return 0;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  const dec = new Float32Array(decoded.reduce((s, d) => s + d.length, 0));
  let at = 0;
  for (const d of decoded) {
    dec.set(d, at);
    at += d.length;
  }
  return bestLag(pcm, dec, MAX_PRIMING);
}

async function encode(pcm: Float32Array): Promise<CleanupResult> {
  if (typeof AudioEncoder === 'undefined') throw new Error('no-encoder');
  const aac = (await AudioEncoder.isConfigSupported(AAC)).supported === true;
  if (!aac && (await AudioEncoder.isConfigSupported(OPUS)).supported !== true) throw new Error('no-encoder');
  const packets: Uint8Array[] = [];
  const found: { description: Uint8Array | null } = { description: null };
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
      const d = meta?.decoderConfig?.description;
      if (d && !found.description) found.description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice(0));
    },
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(aac ? AAC : OPUS);
  for (let at = 0; at < pcm.length; at += CHUNK) {
    const part = pcm.subarray(at, Math.min(at + CHUNK, pcm.length));
    const data = new AudioData({ format: 'f32', sampleRate: SAMPLE_RATE, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((at / SAMPLE_RATE) * 1e6), data: part as Float32Array<ArrayBuffer> });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure || packets.length === 0) throw new Error('no-encoder');
  if (aac) {
    const config = aacConfig(found.description);
    const priming = await primingOf(packets, config, pcm);
    return { data: muxM4a(packets, config, SAMPLE_RATE, AAC.bitrate, pcm.length, priming), mime: 'audio/mp4' };
  }
  // A WebCodecs Opus description is an OpusHead; its pre-skip is at byte 10.
  const head = found.description;
  const preSkip = head && head.length >= 12 ? head[10]! | (head[11]! << 8) : undefined;
  return { data: muxOgg(packets, pcm.length, 960, preSkip), mime: 'audio/ogg' };
}

export async function load(files: Record<string, ArrayBuffer>, ort: typeof Ort): Promise<Engine> {
  if (!files.model) throw new Error('not-loaded');
  const model = new Uint8Array(files.model);
  const meta = denoiseMeta(onnxMetadata(model));
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const bins = meta.nfft / 2 + 1;
  const win = vorbisWindow(meta.windowLength);
  return {
    async run(input, progress) {
      const { pcm } = input as CleanupInput;
      let state: Ort.Tensor = new ort.Tensor('float32', firstState(meta), [meta.stateSize]);
      const spec = new Float32Array(bins * 2);
      await denoiseInPlace(pcm, meta.nfft, meta.hop, win, 2 * meta.windowLength, async (re, im) => {
        for (let k = 0; k < bins; k++) {
          spec[2 * k] = re[k]!;
          spec[2 * k + 1] = im[k]!;
        }
        const out = await session.run({ spec: new ort.Tensor('float32', spec, [1, 1, bins, 2]), state_in: state });
        const e = out.spec_e!.data as Float32Array;
        for (let k = 0; k < bins; k++) {
          re[k] = e[2 * k]!;
          im[k] = e[2 * k + 1]!;
        }
        out.spec_e!.dispose();
        state.dispose();
        state = out.state_out!;
      }, progress);
      state.dispose();
      normalizePeak(pcm);
      return encode(pcm);
    },
    unload() {
      void session.release();
    },
  };
}
