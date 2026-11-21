/** How long a delete waits for the server's pending-delete rows before it
 *  moves on. The rows let the nightly purge remove the files if this device
 *  never sweeps them (since 0136 they no longer change the count); the sweep
 *  re-asserts them, so a stalled write must not hold up the sync that
 *  follows the delete. */
export const PENDING_GC_WAIT_MS = 5000;

/** Wait for `work`, but never longer than `ms`. */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
