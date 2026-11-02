/**
 * The messages between the popup, the background and Chrome's offscreen
 * document. Only the extension's own pages send them; the background checks
 * the sender before it acts.
 */
import type { CapturedPage } from './capture';
import type { ClipMode } from './clipping';
import type { LoginRequest, SaveRequest } from './save';

export type BackgroundMessage =
  | { type: 'save'; request: SaveRequest }
  | { type: 'saveLogin'; request: LoginRequest }
  | { type: 'flush' }
  | { type: 'copy'; text: string; clearAfter?: boolean };

export type OffscreenMessage =
  | { target: 'offscreen'; type: 'clip'; page: CapturedPage; mode: ClipMode; anyway: boolean }
  | { target: 'offscreen'; type: 'copy'; text: string }
  | { target: 'offscreen'; type: 'read' };
