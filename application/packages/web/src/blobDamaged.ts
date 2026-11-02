/**
 * A blob that arrived but does not open: the wrong key, damaged bytes or a
 * bad auth tag. Both stores throw it in place of the cipher's own error, so a
 * reader can tell it from a blob that is absent or a request that failed:
 * those can succeed on their own later, this one only after a person retries.
 * Nothing is deleted for it. Bug triage report 30.
 */
export class BlobDamagedError extends Error {
  constructor(uuid: string) {
    super(`Blob ${uuid} does not open`);
    this.name = 'BlobDamagedError';
  }
}

export function isBlobDamaged(err: unknown): err is BlobDamagedError {
  return err instanceof BlobDamagedError;
}
