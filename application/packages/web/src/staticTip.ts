/**
 * The CSS tooltip of the pages that have no React: the site footer and the
 * static pages (/changelog). It draws the element's `data-tip` with the look
 * and the places of the app's HoverLabel, so a tip reads the same everywhere.
 * Put `tip` and one place class on the element:
 *   tip-start      left of the control, centered (HoverLabel `start`)
 *   tip-above-end  above it, end edges lined up (HoverLabel `above-end`)
 * A `.done` element keeps its tip shown, for a "copied" answer.
 * Spec: packages/web/src/HoverLabel.tsx (TIP_SKIN and positionClasses)
 */
export const STATIC_TIP_CSS = `.tip{position:relative}
.tip::after{content:attr(data-tip);position:absolute;z-index:2;padding:3px 8px;border:1px solid #262626;border-radius:5px;background:#171717;color:#f5f5f5;font:400 var(--fs-small)/16px Inter,system-ui,sans-serif;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s,transform .12s}
:root[data-theme=dark] .tip::after{background:#262626;border-color:#404040}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .tip::after{background:#262626;border-color:#404040}}
.tip-start::after{right:100%;top:50%;margin-right:8px;transform:translate(2px,-50%)}
.tip-start:is(:hover,:focus-visible,.done)::after{opacity:1;transform:translate(0,-50%)}
.tip-above-end::after{right:0;bottom:100%;margin-bottom:8px;transform:translateY(2px)}
.tip-above-end:is(:hover,:focus-visible,.done)::after{opacity:1;transform:none}
@media (hover:none){.tip:hover:not(.done)::after{opacity:0}}
@media (prefers-reduced-motion:reduce){.tip::after{transition:none}}`;
