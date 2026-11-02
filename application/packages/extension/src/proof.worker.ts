/** The Argon2id proof, computed away from the popup's thread (see proof.ts). */
import { deriveUnlockProof } from '@notes/shared/extension';

self.onmessage = (e: MessageEvent<{ secret: string; salt: ArrayBuffer }>) => {
  const proof = deriveUnlockProof(e.data.secret, new Uint8Array(e.data.salt));
  const out = proof.slice().buffer;
  (self as unknown as Worker).postMessage(out, [out]);
};
