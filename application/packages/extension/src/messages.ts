/**
 * The messages between the popup, the background and Chrome's offscreen
 * document. Only the extension's own pages send them; the background checks
 * the sender before it acts. The one message from a script inside a site,
 * the fill script's probe answer, has its own type and its own door
 * (`src/fill/types.ts`, `src/fillRun.ts`).
 */
import type { CapturedPage } from './capture';
import type { ClipMode } from './clipping';
import type { LoginRequest, NoteRequest, SaveRequest } from './save';

export type BackgroundMessage =
  | { type: 'save'; request: SaveRequest }
  | { type: 'saveLogin'; request: LoginRequest }
  | { type: 'saveNote'; request: NoteRequest }
  | { type: 'flush' }
  | { type: 'fill'; item: string; tabId: number }
  | { type: 'copy'; text: string; clearAfter?: boolean };

export type OffscreenMessage =
  | { target: 'offscreen'; type: 'clip'; page: CapturedPage; mode: ClipMode; anyway: boolean }
  | { target: 'offscreen'; type: 'copy'; text: string }
  | { target: 'offscreen'; type: 'read' };
