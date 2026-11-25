import type { ReactNode } from 'react';
import { Modal, ModalFooter } from './Modal';

/**
 * @catalog ProgressModal
 * use: blocking or cancellable progress dialogs (exports, file uploads): sits at `z-[100]` over Settings and toasts, disables Escape/close while `canClose` is false, and gates backdrop close separately via `closeOnBackdrop`.
 * never: a `fixed inset-0 z-[100]` progress overlay drawn by hand.
 */
export function ProgressModal({
  title,
  icon,
  onClose,
  canClose = true,
  closeOnBackdrop,
  maxWidth = 'max-w-sm',
  layer = 'z-[100]',
  footer,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  canClose?: boolean;
  closeOnBackdrop?: boolean;
  maxWidth?: string;
  layer?: 'z-50' | 'z-[60]' | 'z-[70]' | 'z-[100]';
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      icon={icon}
      onClose={canClose ? onClose : undefined}
      escape={canClose}
      closeOnBackdrop={closeOnBackdrop ?? canClose}
      header="bar"
      layer={layer}
      className={`${maxWidth} max-h-[80vh] flex flex-col overflow-hidden`}
    >
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3 min-h-0">{children}</div>
      {footer && <ModalFooter bar>{footer}</ModalFooter>}
    </Modal>
  );
}
