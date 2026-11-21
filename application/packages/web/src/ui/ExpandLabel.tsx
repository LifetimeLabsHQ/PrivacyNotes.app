/**
 * A label that slides open beside an icon while its `group` parent is hovered
 * (a grid column from 0fr to 1fr), and stays shut on a touch screen, where
 * the parent's `aria-label` names it. The sidebar footer actions and the kind
 * bar of the Vault and Files (`KindChips`) use it.
 * Spec: docs/internal/design/ui-patterns.md sections 46 and 190
 */
export function ExpandLabel({ children, className = '' }: {
  children: string;
  /** Extra classes on the outer column, such as `pn-sb-wide` in the sidebar. */
  className?: string;
}) {
  return (
    <span className={`grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 group-hover:grid-cols-[1fr] [@media(hover:none)]:hidden ${className}`}>
      <span className="overflow-hidden whitespace-nowrap text-small font-medium opacity-0 transition-[opacity,padding] duration-200 group-hover:opacity-100 group-hover:ps-1">{children}</span>
    </span>
  );
}
