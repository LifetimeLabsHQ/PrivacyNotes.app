/**
 * Apple's on-device engines through the app's `apple-ml` Tauri plugin (iOS
 * and macOS only, D9): Vision reads text, VisionKit scans a page,
 * SpeechAnalyzer turns speech into text. Every input
 * goes as bytes in memory, never as a file (D16). The page calls these: a Web
 * Worker has no Tauri IPC.
 * Spec: docs/internal/plans/plugins.md (section 6.7), docs/internal/specs/plugins-apple.md (section 4)
 */

type OcrAnswer = { lines: { text: string }[] };

/**
 * One native call of each kind at a time. Rust answers `busy` to a second
 * `ocr` or `transcribe` (beta #242 entry 5), and a stopped job's native call
 * runs until it settles, so the next one waits for it here.
 */
const lanes = new Map<'ocr' | 'transcribe', Promise<unknown>>();

function inLane<T>(lane: 'ocr' | 'transcribe', call: () => Promise<T>): Promise<T> {
  const next = (lanes.get(lane) ?? Promise.resolve()).then(call);
  lanes.set(lane, next.catch(() => undefined));
  return next;
}

/**
 * The text of a picture through Apple Vision. An empty language list lets
 * Vision detect the language: a list led by a Latin language reads nothing of
 * a Japanese page (`plugins-apple.md` 5.1).
 */
export async function appleOcr(bytes: ArrayBuffer): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const answer = await inLane('ocr', () => invoke<OcrAnswer>('plugin:apple-ml|ocr', new Uint8Array(bytes), { headers: { 'x-languages': '' } }));
  return answer.lines.map((l) => l.text).join('\n').trim();
}

/**
 * Apple's document camera (iOS): the first page as JPEG bytes and how many
 * pages the camera took, or null when the person cancels. The camera cannot
 * be held to one page and the app keeps one (D11), so the caller says when
 * the others were left out (`media:scanFirstPageOnly`).
 */
export async function appleScanPages(): Promise<{ jpeg: Uint8Array; pages: number } | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    // One byte with the page count, then the JPEG (src/lib.rs `scan`).
    const answer = new Uint8Array(await invoke<ArrayBuffer>('plugin:apple-ml|scan', { quality: 0.85 }));
    return { pages: answer[0] ?? 1, jpeg: answer.subarray(1) };
  } catch (e) {
    if (String(e).includes('canceled')) return null;
    throw e;
  }
}

/** What the OS says about its speech model for a locale. */
export type SpeechStatus = { locale: string; status: 'unsupported' | 'supported' | 'downloading' | 'installed' };

/** SpeechAnalyzer's model for a locale; throws `os-too-old` below iOS and macOS 26. */
export async function appleSpeechStatus(locale: string): Promise<SpeechStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SpeechStatus>('plugin:apple-ml|speech_status', { locale });
}

/** Asks the OS to fetch its model for a locale; `onProgress` gets 0 to 1. Throws `too-many` past the OS limit of speech languages. */
export async function appleSpeechInstall(locale: string, onProgress: (fraction: number) => void): Promise<SpeechStatus> {
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const channel = new Channel<{ fraction: number }>();
  channel.onmessage = (m) => onProgress(m.fraction);
  return invoke<SpeechStatus>('plugin:apple-ml|speech_install', { locale, onProgress: channel });
}

/**
 * The text of 16 kHz mono 16-bit PCM, as segments with their times in
 * seconds. The signal stops it: Swift cancels the analyzer, and the call
 * fails `canceled` (beta #242 entry 2).
 */
export async function appleTranscribe(pcm16: Uint8Array, locale: string, signal: AbortSignal): Promise<{ segments: { text: string; start: number; end: number }[] }> {
  const { invoke } = await import('@tauri-apps/api/core');
  return inLane('transcribe', async () => {
    signal.throwIfAborted();
    const stop = () => void invoke('plugin:apple-ml|cancel').catch(() => undefined);
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await invoke<{ segments: { text: string; start: number; end: number }[] }>('plugin:apple-ml|transcribe', pcm16, { headers: { 'x-locale': locale } });
    } finally {
      signal.removeEventListener('abort', stop);
    }
  });
}
