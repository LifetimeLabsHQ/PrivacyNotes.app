import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor as TipTapEditor } from '@tiptap/react';
import { GRIP_SVG, dragBlock, svgCopy } from './editorTasks';
import { TIP_PILL, positionClasses } from './HoverLabel';

/**
 * The drag grip of a callout or a Kanban board (#628): the task grip's icon
 * and the task grip's drag, for a React node view. It is never part of the
 * document, and it shows only while the note can be edited. Its hover tip
 * lands before it, so it never covers the block's own title.
 */
export function BlockGrip({ editor, getPos, className }: {
  editor: TipTapEditor;
  getPos: () => number | undefined;
  className: string;
}) {
  const { t } = useTranslation('editor');
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const grip = ref.current;
    if (!grip) return;
    const svg = svgCopy(GRIP_SVG);
    grip.prepend(svg);
    const onDown = (event: PointerEvent) => dragBlock(event, getPos, editor);
    grip.addEventListener('pointerdown', onDown);
    return () => {
      grip.removeChild(svg);
      grip.removeEventListener('pointerdown', onDown);
    };
  }, [editor, getPos]);
  return (
    <span
      ref={ref}
      className={`pn-block-grip pn-tip-host relative group/tip ${className}`}
      contentEditable={false}
      aria-hidden="true"
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={`${TIP_PILL} ${positionClasses.start} whitespace-nowrap`}>{t('callout.dragGrip')}</span>
    </span>
  );
}
