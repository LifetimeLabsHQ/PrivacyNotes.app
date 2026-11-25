import type { KeyboardEventHandler, ReactNode, RefObject } from 'react';
import { ListSearchInput } from '../ListSearchInput';
import { Modal, ModalFooter } from './Modal';

/**
 * @catalog PickerModal
 * use: every searchable or scrollable item picker window (folder picker, tag picker, look picker, picture picker): wraps `Modal` with a bar header, optional `ListSearchInput`, optional filter `subHeader`, scrollable body, and optional `ModalFooter`.
 * never: a `fixed inset-0` picker overlay of your own; a custom search box inside a picker dialog.
 */
export function PickerModal({
  title,
  icon,
  subtitle,
  onClose,
  search,
  subHeader,
  footer,
  maxWidth = 'max-w-sm',
  maxHeight = 'max-h-[75vh]',
  bodyClassName = 'flex-1 overflow-y-auto px-2 pb-2 min-h-0',
  layer,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    ariaLabel?: string;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    inputRef?: RefObject<HTMLInputElement | null>;
  };
  subHeader?: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  maxHeight?: string;
  bodyClassName?: string;
  layer?: 'z-50' | 'z-[60]' | 'z-[70]' | 'z-[100]';
  children: ReactNode;
}) {
  return (
    <Modal
      data-no-app-menu
      onClose={onClose}
      title={title}
      icon={icon}
      subtitle={subtitle}
      header="bar"
      layer={layer}
      className={`${maxWidth} ${maxHeight} flex flex-col overflow-hidden`}
    >
      {search && (
        <div className="px-4 pt-3 pb-2 shrink-0">
          <ListSearchInput
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder}
            ariaLabel={search.ariaLabel}
            onKeyDown={search.onKeyDown}
            inputRef={search.inputRef}
          />
        </div>
      )}
      {subHeader}
      <div className={bodyClassName}>{children}</div>
      {footer && <ModalFooter bar>{footer}</ModalFooter>}
    </Modal>
  );
}
