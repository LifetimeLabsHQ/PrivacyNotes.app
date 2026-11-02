/**
 * The unlock proof, off the popup's thread. Argon2id at the checker's cost
 * (19 MiB, two passes) takes long enough to freeze the PIN boxes; a worker
 * computes it while the popup paints "Unlocking". Where a worker cannot
 * start, the popup computes it in place, as before.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.2, the checker KDF)
 */
import { deriveUnlockProof } from '@notes/shared/extension';

export function deriveProof(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve) => {
    let worker: Worker | null = null;
    const inPlace = () => {
      worker?.terminate();
      resolve(deriveUnlockProof(secret, salt));
    };
    try {
      worker = new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return inPlace();
    }
    worker.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      worker!.terminate();
      resolve(new Uint8Array(e.data));
    };
    worker.onerror = inPlace;
    // The secret goes to the extension's own worker only; nothing is stored.
    const copy = salt.slice().buffer;
    worker.postMessage({ secret, salt: copy }, [copy]);
  });
}
