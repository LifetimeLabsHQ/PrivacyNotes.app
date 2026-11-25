import type { Icon } from './icons';
import { Button, IconTile } from './ui';

/**
 * The ask-before-you-see banner: a dashed card carrying an icon, a
 * heading, one body line, a reveal button and a footnote.
 *
 * Two callers, two tones:
 *  - BurnNote (`danger`): revealing deletes the note from the server.
 *  - PhraseView (`warning`): the words open every device, so the
 *    settings tab keeps them covered until asked. Nothing is destroyed
 *    here, and red would say otherwise.
 *
 * `compact` is the settings-modal size. The burn page is a wide card on
 * an otherwise empty page; the phrase gate sits inside a max-w-md modal
 * where p-8 and a 48px glyph leave no room for the words underneath.
 */

const TONES = {
  danger: 'border-danger/40 bg-danger/10',
  warning: 'border-warning/40 bg-warning/10',
} as const;

export function RevealGate({
  tone,
  glyph: Glyph,
  heading,
  body,
  actionLabel,
  footnote,
  onReveal,
  compact = false,
}: {
  tone: 'danger' | 'warning';
  glyph: Icon;
  heading: string;
  body: string;
  actionLabel: string;
  footnote: string;
  onReveal: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border-2 border-dashed text-center ${
        compact ? 'p-6 space-y-4' : 'p-8 space-y-6'
      } ${TONES[tone]}`}
    >
      <div className="flex justify-center">
        <IconTile tone={tone} size={compact ? 'sm' : 'md'}>
          <Glyph weight="duotone" aria-hidden="true" />
        </IconTile>
      </div>
      <div>
        <p className={`font-semibold text-pn ${compact ? 'text-title' : 'text-heading'}`}>
          {heading}
        </p>
        {/* text-balance: two or three short centered lines, where the
            default greedy wrap leaves a stub on the last one. */}
        <p className="text-body text-pn-soft mt-2 text-balance">
          {body}
        </p>
      </div>
      <div>
        <Button
          action="view"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={onReveal}
        >
          {actionLabel}
        </Button>
      </div>
      <p className="text-help text-pn-soft">
        {footnote}
      </p>
    </div>
  );
}
