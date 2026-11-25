import type { ReactNode } from 'react';
import { Modal, ModalFooter } from './Modal';

/**
 * @catalog PluginSheet
 * use: the shared window frame for on-device AI and plugin sheets (OCR, Translate, Voice to text, Find duplicates), pairing `Modal` at `z-[60]` with `ModalFooter`.
 * never: a plugin sheet that omits `ModalFooter` or hand-rolls its own button bar.
 */
export function PluginSheet({
  title,
  icon,
  subtitle,
  onClose,
  header = 'inline',
  maxWidth = 'max-w-lg',
  layer = 'z-[60]',
  escape = true,
  footer,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  header?: 'inline' | 'bar';
  maxWidth?: string;
  layer?: 'z-50' | 'z-[60]' | 'z-[70]' | 'z-[100]';
  escape?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  if (header === 'bar') {
    return (
      <Modal
        title={title}
        icon={icon}
        subtitle={subtitle}
        onClose={onClose}
        escape={escape}
        header="bar"
        layer={layer}
        className={`${maxWidth} max-h-[85vh] flex flex-col overflow-hidden`}
      >
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">{children}</div>
        {footer && <ModalFooter bar>{footer}</ModalFooter>}
      </Modal>
    );
  }
  return (
    <Modal
      title={title}
      icon={icon}
      subtitle={subtitle}
      onClose={onClose}
      escape={escape}
      header="inline"
      layer={layer}
      className={`${maxWidth} p-6 space-y-4`}
    >
      {children}
      {footer && <ModalFooter>{footer}</ModalFooter>}
    </Modal>
  );
}
