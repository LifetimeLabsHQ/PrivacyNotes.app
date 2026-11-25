import type { ReactNode } from 'react';
import { IconTile } from './misc';

/**
 * @catalog GateCard
 * use: centered security, PIN, biometric, or reveal unlock gates (`LockScreen`, `ProtectedNoteGate`, `SectionGate`, `RevealGate`, `PhrasePinGate`): optional `IconTile`, heading, subtitle, secret/biometric controls, and footer links.
 * never: bespoke centered unlock headers or custom colored lock icon circles on each gate screen.
 */
export function GateCard({
  icon,
  tone = 'info',
  title,
  subtitle,
  framed = false,
  maxWidth = 'max-w-xs',
  footer,
  className = '',
  children,
}: {
  icon?: ReactNode;
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title: ReactNode;
  subtitle?: ReactNode;
  framed?: boolean;
  maxWidth?: string;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`w-full ${maxWidth} mx-auto text-center space-y-5${
        framed ? ' rounded-xl border border-divider bg-surface-2 p-6 shadow-sm' : ''
      }${className ? ` ${className}` : ''}`}
    >
      <div className="space-y-2">
        {icon && (
          <div className="flex justify-center">
            <IconTile tone={tone}>{icon}</IconTile>
          </div>
        )}
        <h2 className="text-heading font-semibold text-pn">{title}</h2>
        {subtitle && <p className="text-body text-pn-muted">{subtitle}</p>}
      </div>
      {children}
      {footer && <div className="pt-1 space-y-2">{footer}</div>}
    </div>
  );
}
