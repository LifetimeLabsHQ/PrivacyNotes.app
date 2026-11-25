import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Plus } from '../icons';
import { IconUpgrade } from '../proMark';

/**
 * @catalog DashedAddButton
 * use: the dashed-border "Add ..." slot button in forms and settings lists (trackers, medications, custom fields, contact rows), with optional `fullWidth` and `pro` rocket badge.
 * never: a hand-drawn `border-dashed` button with custom padding, text role, or hover classes.
 */
export function DashedAddButton({
  icon,
  pro = false,
  fullWidth = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon?: ReactNode;
  pro?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      {...rest}
      className={`${fullWidth ? 'w-full ' : ''}inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-divider px-3 py-2 text-compact font-medium text-pn-soft hover:border-accent hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition${className ? ` ${className}` : ''}`}
    >
      {icon ?? <Plus aria-hidden="true" />}
      {children}
      {pro && <IconUpgrade size={12} />}
    </button>
  );
}
