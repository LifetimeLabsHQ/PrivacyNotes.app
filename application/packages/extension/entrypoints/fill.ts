/**
 * The fill script. The background puts it into a tab only when the person
 * chooses Fill or presses the login key; it is declared for no page and no
 * page can load it. It runs in the extension's isolated world and puts two
 * functions there for the background's next calls: `probe`, which says what
 * this frame could fill, and `fill`, which writes one login.
 *
 * A fill is taken only for the run that was just probed in this very
 * document, once.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.1 and 3.2)
 */
import { browser } from 'wxt/browser';
import { fill, probe } from '../src/fill/engine';
import type { FillApi, FillProbeMessage, FrameReport } from '../src/fill/types';

export default defineUnlistedScript(() => {
  const scope = globalThis as { __pnFill?: FillApi };
  if (scope.__pnFill) return;
  let open = '';
  scope.__pnFill = {
    probe(runId) {
      open = runId;
      let report: FrameReport | null = null;
      try {
        report = probe(document);
      } catch {
        report = null;
      }
      // Always an answer, so the background does not wait for this frame.
      const message: FillProbeMessage = { type: 'fillProbe', runId, report };
      void browser.runtime.sendMessage(message).catch(() => undefined);
    },
    async fill(request) {
      if (!open || request.runId !== open) return { filled: [], waiting: false };
      open = '';
      try {
        return await fill(document, request);
      } catch {
        return { filled: [], waiting: false };
      }
    },
  };
});
