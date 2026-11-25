import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { BellSimple, Repeat as RepeatGlyph } from './icons';
import { atomDeleteKeys } from './editorAtomKeys';
import { toLocalIso } from './intlFormat';
import { suppressSoftKeyboard } from './softKeyboard';
import {
  formatTaskReminderSpec,
  nextTaskReminder,
  parseTaskReminderSpec,
  TASK_REMINDER_HEAD_RE,
  taskReminderMarkdown,
  type TaskReminder,
} from './taskReminderSyntax';
import { formatTaskReminderLabel, formatTaskRepeatLabel, isTaskReminderOverdue } from './taskReminderText';

/**
 * Inline TipTap atom node for per-checkbox reminders: `:remind[YYYY-MM-DD HH:MM ...]`.
 *
 * Sibling of `InlineIcon` (`editorIcon.tsx`): round-trips cleanly through
 * `tiptap-markdown`, travels with the task on drag, indent, copy/paste, sync,
 * and Markdown export, and renders as a clickable reminder pill inside the task.
 */

interface ReminderParseState {
  src: string;
  pos: number;
  posMax: number;
  push: (type: string, tag: string, nesting: number) => { content: string };
}

function taskReminderRule(state: ReminderParseState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3a) return false;
  const slice = state.src.slice(state.pos, Math.min(state.posMax, state.pos + 80));
  const m = TASK_REMINDER_HEAD_RE.exec(slice);
  if (!m) return false;
  const parsed = parseTaskReminderSpec(m[1]!);
  if (!parsed) return false;
  if (!silent) {
    const spec = formatTaskReminderSpec(parsed);
    state.push('html_inline', '', 0).content = `<span data-pn-task-reminder="${spec}"></span>`;
  }
  state.pos += m[0].length;
  return true;
}

/** Find the enclosing `taskItem` node position for a node position inside it. */
function findEnclosingTaskItemPos(doc: ProseMirrorNode, pos: number): number | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'taskItem') return $pos.before(d);
  }
  return null;
}

/** Find the first `taskReminder` child in a `taskItem`'s first paragraph. */
export function findTaskReminderInItem(
  item: ProseMirrorNode,
): { offsetInPara: number; nodeSize: number; reminder: TaskReminder } | null {
  const first = item.firstChild;
  if (!first || !first.isTextblock) return null;
  let found: { offsetInPara: number; nodeSize: number; reminder: TaskReminder } | null = null;
  first.forEach((child, offset) => {
    if (found || child.type.name !== 'taskReminder') return;
    const parsed = parseTaskReminderSpec(String(child.attrs.spec ?? ''));
    if (parsed) found = { offsetInPara: offset, nodeSize: child.nodeSize, reminder: parsed };
  });
  return found;
}

/** True when a `taskItem` holds a valid `taskReminder` in its first paragraph. */
export function hasTaskReminderInItem(item: ProseMirrorNode): boolean {
  return findTaskReminderInItem(item) !== null;
}

export interface TaskReminderNodeOptions {
  onOpenReminder?: (anchor: HTMLElement, taskPos: number, current: TaskReminder) => void;
}

function TaskReminderChipView({ node, editor, getPos, extension }: ReactNodeViewProps) {
  const { t } = useTranslation('shell');
  const spec = String(node.attrs.spec ?? '');
  const parsed = parseTaskReminderSpec(spec);
  if (!parsed) return null;

  const todayIso = toLocalIso(new Date());
  const label = formatTaskReminderLabel(parsed, todayIso);
  const repeatText = parsed.repeat ? formatTaskRepeatLabel(parsed.repeat, t) : '';
  const overdue = isTaskReminderOverdue(parsed);
  const editable = editor.isEditable;
  const opts = extension.options as TaskReminderNodeOptions;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!editable || typeof getPos !== 'function') return;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const taskPos = findEnclosingTaskItemPos(editor.state.doc, pos);
    if (taskPos === null) return;
    opts.onOpenReminder?.(e.currentTarget, taskPos, parsed);
  };

  return (
    <NodeViewWrapper as="span" className="pn-task-reminder-wrap" data-pn-task-reminder={spec}>
      <button
        type="button"
        disabled={!editable}
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={() => suppressSoftKeyboard(editor.view.dom as HTMLElement)}
        onClick={handleClick}
        aria-label={`${t('taskReminder.edit')}: ${label}${repeatText ? `, ${repeatText}` : ''}`}
        className={`pn-task-reminder-chip${overdue ? ' pn-task-reminder-overdue' : ''}`}
      >
        <BellSimple className="pn-task-reminder-ico" aria-hidden="true" />
        <span>{label}</span>
        {repeatText && (
          <>
            <span className="pn-task-reminder-dot" aria-hidden="true">·</span>
            <RepeatGlyph className="pn-task-reminder-ico" aria-hidden="true" />
            <span>{repeatText}</span>
          </>
        )}
      </button>
    </NodeViewWrapper>
  );
}

export const TaskReminderNode = Node.create<TaskReminderNodeOptions>({
  name: 'taskReminder',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      onOpenReminder: undefined,
    };
  },

  addAttributes() {
    return { spec: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-pn-task-reminder]',
        getAttrs: (el) => {
          const raw = (el as HTMLElement).getAttribute('data-pn-task-reminder') ?? '';
          const parsed = parseTaskReminderSpec(raw);
          return parsed ? { spec: formatTaskReminderSpec(parsed) } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { spec, ...rest } = HTMLAttributes;
    return ['span', mergeAttributes(rest, { 'data-pn-task-reminder': spec })];
  },

  renderText({ node }) {
    const parsed = parseTaskReminderSpec(String(node.attrs.spec ?? ''));
    return parsed ? taskReminderMarkdown(parsed) : '';
  },

  addNodeView() {
    return ReactNodeViewRenderer(TaskReminderChipView as never);
  },

  addKeyboardShortcuts() {
    return atomDeleteKeys(this.editor, this.type);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { spec?: string } }) {
          const parsed = parseTaskReminderSpec(String(node.attrs.spec ?? ''));
          if (parsed) state.write(taskReminderMarkdown(parsed));
        },
        parse: {
          setup(md: { inline: { ruler: { push: (name: string, fn: typeof taskReminderRule) => void } } }) {
            md.inline.ruler.push('pnTaskReminder', taskReminderRule);
          },
        },
      },
    };
  },
});

/**
 * Set, update, or remove the `taskReminder` node inside the `taskItem` at
 * `taskPos`, in a single undoable ProseMirror transaction.
 */
export function setTaskItemReminder(
  editor: Editor,
  taskPos: number,
  reminder: TaskReminder | null,
): boolean {
  const { state, view } = editor;
  const item = state.doc.nodeAt(taskPos);
  if (!item || item.type.name !== 'taskItem' || !item.firstChild?.isTextblock) return false;
  const paraStart = taskPos + 1;
  const paraContentStart = paraStart + 1;
  const para = item.firstChild;
  const existing = findTaskReminderInItem(item);
  const tr = state.tr;

  if (!reminder) {
    if (!existing) return true;
    const from = paraContentStart + existing.offsetInPara;
    const to = from + existing.nodeSize;
    // Also trim one leading space right before the chip when removing it.
    const charBefore = from > paraContentStart ? state.doc.textBetween(from - 1, from) : '';
    tr.delete(charBefore === ' ' ? from - 1 : from, to);
    view.dispatch(tr);
    return true;
  }

  const spec = formatTaskReminderSpec(reminder);
  const nodeType = state.schema.nodes.taskReminder;
  if (!nodeType) return false;

  if (existing) {
    const nodePos = paraContentStart + existing.offsetInPara;
    tr.setNodeMarkup(nodePos, undefined, { spec });
  } else {
    const insertAt = paraContentStart + para.content.size;
    const needsSpace =
      para.content.size > 0 && !/\s$/.test(para.textBetween(Math.max(0, para.content.size - 1), para.content.size));
    const chip = nodeType.create({ spec });
    // Use an explicit unmarked text node for the separator space so trailing
    // inline code/link/highlight marks do not swallow the space before the chip.
    tr.insert(insertAt, needsSpace ? [state.schema.text(' '), chip] : chip);
  }
  view.dispatch(tr);
  return true;
}

/** Recursively reset every nested `taskItem` inside a fragment to `checked: false`. */
function uncheckNestedTasks(fragment: Fragment): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((child) => {
    if (child.type.name === 'taskItem') {
      children.push(child.type.create({ ...child.attrs, checked: false }, uncheckNestedTasks(child.content), child.marks));
    } else if (child.content.size > 0) {
      children.push(child.type.create(child.attrs, uncheckNestedTasks(child.content), child.marks));
    } else {
      children.push(child);
    }
  });
  return children;
}

/** Build a paragraph with its `taskReminder` node removed (and one leading space trimmed). */
function stripReminderFromParagraph(para: ProseMirrorNode): ProseMirrorNode {
  const kept: ProseMirrorNode[] = [];
  para.forEach((child) => {
    if (child.type.name === 'taskReminder') {
      // Trim trailing space on the preceding text node so no double/trailing space remains.
      const prev = kept[kept.length - 1];
      if (prev?.isText && prev.text && prev.text.endsWith(' ')) {
        const trimmed = prev.text.slice(0, -1);
        if (trimmed) kept[kept.length - 1] = prev.type.schema.text(trimmed, prev.marks);
        else kept.pop();
      }
      return;
    }
    kept.push(child);
  });
  return para.type.create(para.attrs, kept, para.marks);
}

/** Build a paragraph with its `taskReminder` node's `spec` replaced. */
function replaceReminderInParagraph(para: ProseMirrorNode, nextSpec: string): ProseMirrorNode {
  const nodes: ProseMirrorNode[] = [];
  para.forEach((child) => {
    if (child.type.name === 'taskReminder') {
      nodes.push(child.type.create({ ...child.attrs, spec: nextSpec }, null, child.marks));
    } else {
      nodes.push(child);
    }
  });
  return para.type.create(para.attrs, nodes, para.marks);
}

/**
 * Complete a repeating `taskItem` at `pos` inside transaction `tr`:
 *   - Replaces it with a fresh unchecked copy carrying the next reminder date
 *     (and nested subtasks unchecked) plus the completed `[x]` copy with its
 *     reminder stripped.
 * Returns the position of the completed `[x]` copy (for optional sinking/animation),
 * or null if the item at `pos` is not a repeating task.
 */
export function completeRepeatingTaskItem(
  tr: Transaction,
  pos: number,
  todayIso: string,
): number | null {
  const item = tr.doc.nodeAt(pos);
  if (!item || item.type.name !== 'taskItem' || !item.firstChild?.isTextblock) return null;
  const found = findTaskReminderInItem(item);
  if (!found?.reminder.repeat) return null;
  const next = nextTaskReminder(found.reminder, todayIso);
  if (!next) return null;

  const restChildren: ProseMirrorNode[] = [];
  for (let i = 1; i < item.childCount; i++) restChildren.push(item.child(i));

  const nextPara = replaceReminderInParagraph(item.firstChild, formatTaskReminderSpec(next));
  const nextRest = restChildren.map((child) =>
    child.content.size > 0 ? child.type.create(child.attrs, uncheckNestedTasks(child.content), child.marks) : child,
  );
  const nextItem = item.type.create({ ...item.attrs, checked: false }, [nextPara, ...nextRest], item.marks);

  const donePara = stripReminderFromParagraph(item.firstChild);
  const doneItem = item.type.create({ ...item.attrs, checked: true }, [donePara, ...restChildren], item.marks);

  tr.replaceWith(pos, pos + item.nodeSize, [nextItem, doneItem]);
  return pos + nextItem.nodeSize;
}
