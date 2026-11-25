import type { ReactNode } from 'react';
import { Check } from '../icons';
import { SETTINGS_HELP } from '../settingsUI';

/**
 * @catalog Step
 * use: numbered setup steps connected by a vertical progress line (CLI setup, automatic backups, extension onboarding); a completed step turns green with a check mark.
 * never: an unstyled <ol> with manual step numbers or a copy of Step inside a feature file.
 */
export function Step({
  n,
  done,
  last = false,
  title,
  hint,
  children,
}: {
  n: number;
  done: boolean;
  last?: boolean;
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={`relative flex gap-3.5 ${last ? '' : 'pb-5'}`}>
      {!last && (
        <span
          aria-hidden="true"
          className={`absolute start-[13px] top-8 bottom-1 w-0.5 rounded-full ${done ? 'bg-success/50' : 'bg-divider'}`}
        />
      )}
      <span
        aria-hidden="true"
        className={`relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] text-small font-semibold ${
          done ? 'border-success bg-success text-surface-2' : 'border-accent/50 bg-surface-2 text-accent'
        }`}
      >
        {done ? <Check weight="bold" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
        <p className="text-body font-medium text-pn">{title}</p>
        {hint && <p className={SETTINGS_HELP}>{hint}</p>}
        {children}
      </div>
    </li>
  );
}
