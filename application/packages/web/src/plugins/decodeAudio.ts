/**
 * A recording as mono float PCM at the rate a plugin needs (16 kHz for
 * Voice to text, 48 kHz for Remove noise). WebAudio decodes it with the
 * formats the platform has (Linux through GStreamer); a format it cannot
 * read throws `audio-format`.
 * Spec: docs/internal/plans/plugins.md (section 6.6)
 */
export async function decodeAudio(bytes: ArrayBuffer, sampleRate: number): Promise<Float32Array> {
  let decoded: AudioBuffer;
  try {
    decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes);
  } catch {
    throw new Error('audio-format');
  }
  // Rendering through a mono context at that rate resamples and mixes down.
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * sampleRate)), sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * The longest recording Voice to text takes, on every engine: the Apple
 * plugin's own limit (`MAX_PCM` in `apple-ml/src/lib.rs`). An hour of 16 kHz
 * mono float is about 230 MB before any copy (beta #240 item 13).
 * Spec: docs/internal/plans/plugins.md (section 6.6)
 */
export const MAX_AUDIO_S = 3600;

/** How long the browser waits for a recording's header before the length counts as unknown. */
const METADATA_MS = 3000;

/**
 * A recording's length in seconds from its header, read by an audio
 * element without decoding the sound; 0 when the platform will not say.
 */
export async function audioSeconds(bytes: Uint8Array, type: string): Promise<number> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const audio = new Audio();
  try {
    audio.preload = 'metadata';
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), METADATA_MS);
      audio.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(true);
      };
      audio.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      audio.src = url;
    });
    if (!ready) return 0;
    // A file with no length in its header (MediaRecorder's) is scanned to its end.
    const { resolveDuration } = await import('../EncryptedAttachment');
    return await resolveDuration(audio);
  } finally {
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}
